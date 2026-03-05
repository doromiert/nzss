import React, { useState, useRef, useEffect, useMemo } from 'react';

let textareaRef = null;

// --- SEMANTIC PATCH ENGINE ---

// Helper: Scope-aware block scanner
const scanBlock = (code, startIndex, openChars = ['{'], closeChars = ['}']) => {
    let i = startIndex;
    let inParens = 0;
    let blockStart = -1;
    let state = 'NORMAL'; // NORMAL, LINE_COMMENT, BLOCK_COMMENT, STR_SQ, STR_DQ, STR_TPL
    const isBracket = openChars.includes('{') || openChars.includes('[');

    while (i < code.length) {
        const c = code[i], nc = code[i+1];
        if (state === 'NORMAL') {
            if (c === '/' && nc === '/') { state = 'LINE_COMMENT'; i++; }
            else if (c === '/' && nc === '*') { state = 'BLOCK_COMMENT'; i++; }
            else if (c === "'") state = 'STR_SQ';
            else if (c === '"') state = 'STR_DQ';
            else if (c === '`') state = 'STR_TPL';
            else if (c === '(' && isBracket) inParens++;
            else if (c === ')' && isBracket) inParens--;
            else if (openChars.includes(c) && inParens === 0) {
                blockStart = i;
                break;
            }
        } else if (state === 'LINE_COMMENT' && c === '\n') {
            state = 'NORMAL';
        } else if (state === 'BLOCK_COMMENT' && c === '*' && nc === '/') {
            state = 'NORMAL'; i++;
        } else if (state === 'STR_SQ' && c === "'" && code[i-1] !== '\\') {
            state = 'NORMAL';
        } else if (state === 'STR_DQ' && c === '"' && code[i-1] !== '\\') {
            state = 'NORMAL';
        } else if (state === 'STR_TPL' && c === '`' && code[i-1] !== '\\') {
            state = 'NORMAL';
        }
        if (c === '\\' && state.startsWith('STR')) i++;
        i++;
    }

    if (blockStart === -1) return { start: -1, end: -1 };

    let depth = 1;
    i = blockStart + 1;
    state = 'NORMAL';
    const openChar = code[blockStart];
    const closeChar = openChar === '{' ? '}' : (openChar === '[' ? ']' : closeChars[0]);

    while (i < code.length && depth > 0) {
        const c = code[i], nc = code[i+1];
        if (state === 'NORMAL') {
            if (c === '/' && nc === '/') { state = 'LINE_COMMENT'; i++; }
            else if (c === '/' && nc === '*') { state = 'BLOCK_COMMENT'; i++; }
            else if (c === "'") state = 'STR_SQ';
            else if (c === '"') state = 'STR_DQ';
            else if (c === '`') state = 'STR_TPL';
            else if (c === openChar) depth++;
            else if (c === closeChar) depth--;
        } else if (state === 'LINE_COMMENT' && c === '\n') {
            state = 'NORMAL';
        } else if (state === 'BLOCK_COMMENT' && c === '*' && nc === '/') {
            state = 'NORMAL'; i++;
        } else if (state === 'STR_SQ' && c === "'" && code[i-1] !== '\\') {
            state = 'NORMAL';
        } else if (state === 'STR_DQ' && c === '"' && code[i-1] !== '\\') {
            state = 'NORMAL';
        } else if (state === 'STR_TPL' && c === '`' && code[i-1] !== '\\') {
            state = 'NORMAL';
        }
        if (c === '\\' && state.startsWith('STR')) i++;
        if (depth === 0) return { start: blockStart, end: i };
        i++;
    }
    return { start: blockStart, end: -1 };
};

const findFuzzyMatch = (text, pattern, threshold = 0.8) => {
    const strict = text.indexOf(pattern);
    if (strict !== -1) return { start: strict, end: strict + pattern.length };
    const patternLines = pattern.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    if (patternLines.length === 0) return null;
    const textLines = text.split('\n');
    let bestScore = 0;
    let result = null;
    for (let i = 0; i <= textLines.length - patternLines.length; i++) {
        let matches = 0;
        for (let j = 0; j < patternLines.length; j++) {
            if (textLines[i + j].trim() === patternLines[j]) matches++;
        }
        const score = matches / patternLines.length;
        if (score > bestScore && score >= threshold) {
            bestScore = score;
            const charStart = textLines.slice(0, i).join('\n').length + (i > 0 ? 1 : 0);
            const charEnd = textLines.slice(0, i + patternLines.length).join('\n').length;
            result = { start: charStart, end: charEnd };
        }
    }
    return result;
};

const applySemanticPatch = (baseCode, semanticPatch) => {
    let modifications = [];
    const parts = semanticPatch.split(/^@ END\s*$/m);
    
    parts.forEach(part => {
        if (!part.trim()) return;
        const targetMatch = part.match(/^@ TARGET:\s+(FUNCTION|VARIABLE|JSON_PATH|SECTION)(?:\s+([a-zA-Z0-9_$.]+))?/m);
        if (!targetMatch) return;
        const type = targetMatch[1];
        const id = targetMatch[2];
        let startIndex = -1, endIndex = -1, newContent = "";
        
        if (type === 'SECTION') {
            const replacedMatch = part.match(/^@ REPLACED:\r?\n([\s\S]*?)\n^@ NEWCONTENT:\r?\n([\s\S]*)/m);
            if (replacedMatch) {
                const fuzzy = findFuzzyMatch(baseCode, replacedMatch[1]);
                if (fuzzy) {
                    startIndex = fuzzy.start;
                    endIndex = fuzzy.end;
                    newContent = replacedMatch[2].replace(/\n+$/, '');
                }
            }
        } else {
            const actionMatch = part.match(/^@ ACTION:\s+(REPLACE_BODY|REPLACE_ALL|REPLACE_FUNCTION)/m);
            if (!actionMatch) return;
            const action = actionMatch[1];
            const actionIndex = part.indexOf(actionMatch[0]);
            const contentStart = part.indexOf('\n', actionIndex) + 1;
            newContent = part.slice(contentStart).replace(/\n+$/, '');
            
            if (type === 'FUNCTION' || type === 'VARIABLE') {
                const findIdRegex = new RegExp(`(?:const|let|var|function|async function)\\s+${id}\\s*[=(]|${id}\\s*[:=]\\s*[=(]`);
                const match = baseCode.match(findIdRegex);
                if (match) {
                    const block = scanBlock(baseCode, match.index, ['{'], ['}']);
                    if (block.start !== -1 && block.end !== -1) {
                        if (action === 'REPLACE_ALL' || action === 'REPLACE_FUNCTION') {
                            startIndex = match.index; endIndex = block.end + 1;
                        } else if (action === 'REPLACE_BODY') {
                            startIndex = block.start + 1; endIndex = block.end;
                            newContent = "\n" + newContent + "\n";
                        }
                    }
                }
            } else if (type === 'JSON_PATH') {
                const jsonKeyRegex = new RegExp(`"${id}"\\s*:`);
                const match = baseCode.match(jsonKeyRegex);
                if (match) {
                    const valStart = baseCode.indexOf(':', match.index) + 1;
                    let i = valStart;
                    while(baseCode[i] && /\s/.test(baseCode[i])) i++;
                    if (baseCode[i] === '{' || baseCode[i] === '[') {
                        const block = scanBlock(baseCode, i, ['{', '['], ['}', ']']);
                        if (block.start !== -1 && block.end !== -1) { startIndex = block.start; endIndex = block.end + 1; }
                    } else {
                        let blockEnd = i;
                        while(blockEnd < baseCode.length && baseCode[blockEnd] !== ',' && baseCode[blockEnd] !== '\n') blockEnd++;
                        startIndex = i; endIndex = blockEnd;
                    }
                }
            }
        }
        if (startIndex !== -1 && endIndex !== -1) {
            if (baseCode[endIndex] === ';' && newContent.trim().endsWith(';')) endIndex++;
            const overlaps = modifications.some(m => Math.max(startIndex, m.startIndex) < Math.min(endIndex, m.endIndex));
            if (!overlaps) modifications.push({ startIndex, endIndex, newContent });
        }
    });

    modifications.sort((a, b) => a.startIndex - b.startIndex);
    let currentPatched = baseCode, appliedMods = [], cumulativeOffset = 0;
    modifications.forEach(mod => {
        const adjustedStart = mod.startIndex + cumulativeOffset;
        currentPatched = currentPatched.slice(0, adjustedStart) + mod.newContent + currentPatched.slice(mod.endIndex + cumulativeOffset);
        appliedMods.push({ start: adjustedStart, end: adjustedStart + mod.newContent.length });
        cumulativeOffset += (mod.newContent.length - (mod.endIndex - mod.startIndex));
    });
    
    let chunks = [], lastIndex = 0;
    modifications.forEach(mod => {
        if (mod.startIndex > lastIndex) chunks.push({ type: 'unchanged', content: baseCode.substring(lastIndex, mod.startIndex) });
        chunks.push({ type: 'removed', content: baseCode.substring(mod.startIndex, mod.endIndex) });
        chunks.push({ type: 'added', content: mod.newContent });
        lastIndex = mod.endIndex;
    });
    if (lastIndex < baseCode.length) chunks.push({ type: 'unchanged', content: baseCode.substring(lastIndex) });

    return { 
        patchedCode: currentPatched, 
        chunks, 
        patchCount: modifications.length, 
        appliedMods, 
        targetOffsets: modifications.map(m => ({ start: m.startIndex, end: m.endIndex })) 
    };
};

// --- SYNTAX HIGHLIGHTING ENGINE ---

const SYNTAX_DEF = {
    js: { comment: /\/\/.*|\/\*[\s\S]*?\*\//, string: /".*?"|'.*?'|`[\s\S]*?`/, keyword: /\b(?:const|let|var|function|return|if|else|for|while|import|export|from|class|default|new|this|async|await|true|false|null|undefined)\b/, number: /\b\d+(?:\.\d+)?\b/ },
    nix: { comment: /#.*/, string: /".*?"|''.*?''/, keyword: /\b(?:rec|with|let|in|inherit|if|then|else|true|false|null|import)\b/ },
    rust: { comment: /\/\/.*/, string: /".*?"/, keyword: /\b(?:fn|let|mut|pub|match|if|else|for|in|while|loop|return|struct|enum|impl|use|mod|trait|true|false|Some|None|Ok|Err)\b/, number: /\b\d+(?:\.\d+)?\b/ },
    c: { comment: /\/\/.*/, string: /".*?"|'.*?'/, keyword: /\b(?:int|char|float|double|void|if|else|for|while|return|struct|typedef|switch|case|break|continue|default|static|extern|const)\b/, directive: /#\w+/ },
    asm: { comment: /;.*/, string: /".*?"|'.*?'/, keyword: /\b(?:mov|push|pop|add|sub|inc|dec|cmp|jmp|je|jne|jg|jl|call|ret|xor|and|or|not|int|section|global|extern)\b/i },
    html: { comment: /<!--[\s\S]*?-->/, string: /".*?"|'.*?'/, keyword: /<\/?[\w:-]+/ },
    svelte: { comment: /<!--[\s\S]*?-->|\/\/.*/, string: /".*?"|'.*?'|`[\s\S]*?`/, keyword: /<\/?[\w:-]+|#(?:if|each|await)|:(?:else|then)|\/(?:if|each|await)/ },
    css: { comment: /\/\*[\s\S]*?\*\//, string: /".*?"|'.*?'/, keyword: /[\w-]+\s*:/, number: /\b\d+(?:px|em|rem|%|vh|vw)?\b/ },
    scss: { comment: /\/\/.*|\/\*[\s\S]*?\*\//, string: /".*?"|'.*?'/, keyword: /[\w-]+\s*:|@[\w-]+|\$[\w-]+/, number: /\b\d+(?:px|em|rem|%|vh|vw)?\b/ },
    md: { comment: /<!--[\s\S]*?-->/, string: /\[.*?\]\(.*?\)|`.*?`/, keyword: /^#+\s.*|\*\*.*?\*\*|__.*?__|_[^_]+_|\*[^*]+\*/ },
    lua: { comment: /--.*/, string: /".*?"|'.*?'|\[\[[\s\S]*?\]\]/, keyword: /\b(?:local|function|return|if|then|else|elseif|end|for|while|do|in|repeat|until|and|or|not|true|false|nil)\b/, number: /\b\d+(?:\.\d+)?\b/ }
};

const SYNTAX_COLORS = {
    comment: 'text-slate-500 italic',
    string: 'text-emerald-400',
    keyword: 'text-purple-400 font-bold',
    number: 'text-amber-400',
    directive: 'text-indigo-400 font-bold'
};

const compileTokenizer = (lang) => {
    const def = SYNTAX_DEF[lang];
    if (!def) return null;
    const parts = [], types = [];
    for (const [type, regex] of Object.entries(def)) {
        parts.push(`(${regex.source})`);
        types.push(type);
    }
    return { regex: new RegExp(parts.join('|'), 'g'), types };
};

// --- LIBADWAITA UI COMPONENTS ---

const LineNumbers = ({ text, scrollRef, changedLines = [], previewLines = [], lineMetadata = {} }) => {
    const lineCount = text.split('\n').length;
    
    const getGlowClass = (idx) => {
        if (lineMetadata[idx]) {
            const status = lineMetadata[idx];
            if (status === 'modified') return "text-[var(--accent-primary)] drop-shadow-[0_0_6px_var(--accent-primary)] font-black";
            if (status === 'removed') return "text-red-400 drop-shadow-[0_0_6px_rgba(248,113,113,0.8)] font-black";
            if (status === 'added') return "text-emerald-400 drop-shadow-[0_0_6px_rgba(52,211,153,0.8)] font-black";
        }
        
        const isPast = changedLines.includes(idx);
        const isFuture = previewLines.includes(idx);

        if (isPast && isFuture) return "text-amber-400 drop-shadow-[0_0_8px_rgba(251,191,36,1.0)] font-black";
        if (isPast) return "text-[var(--accent-primary)] drop-shadow-[0_0_6px_var(--accent-primary)] font-black";
        if (isFuture) return "text-white drop-shadow-[0_0_6px_rgba(255,255,255,0.9)] font-black";

        return "";
    };

    return (
        <div 
            ref={scrollRef}
            className="w-10 flex-shrink-0 bg-[var(--bg-header)] -[var(--border-color)] text-[var(--text-dim)] font-mono text-[10px] text-right pr-2 pt-4 pb-4 select-none overflow-hidden"
            style={{ lineHeight: '1.5rem' }}
        >
            {Array.from({ length: Math.max(1, lineCount) }).map((_, i) => (
                <div 
                    key={i} 
                    className={`transition-all w-[32px] duration-300 ${getGlowClass(i)}`}
                >
                    {i + 1}
                </div>
            ))}
        </div>
    );
};

const CodeEditor = ({ value, onChange, placeholder, label, colorClass, readOnly = false, className = "", changedLines = [], previewLines = [], language = null }) => {
    const renderHighlightedCode = (text) => {
        if (!text) return null;

        // Custom highlighting for NZSS directives
        let highlighted = text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');

        // Target @KEYWORD (the first word after @)
        highlighted = highlighted.replace(/^(@\s*)([A-Z_]+)/gm, (match, at, keyword) => {
            return `${at}<span class="${colorClass} font-bold brightness-125">${keyword}</span>`;
        });

        if (language === 'json') {
            highlighted = highlighted.replace(/"([^"]+)":/g, '<span class="text-blue-400">"$1"</span>:');
        }

        return <div dangerouslySetInnerHTML={{ __html: highlighted }} />;
    };

    return (
        <div className={`flex flex-col h-full overflow-hidden ${className}`}>
            <div className="px-4 py-2 flex justify-between items-center bg-[var(--bg-header)] ">
            <span className={`text-[10px] font-black uppercase tracking-widest ${colorClass}`}>{label}</span>
            </div>
            <div className="relative flex-1 font-mono text-sm overflow-hidden group bg-[var(--bg-main)]">
                <div 
                    className="absolute inset-0 p-4 pointer-events-none whitespace-pre-wrap break-all overflow-y-auto custom-scrollbar"
                    style={{ color: 'transparent' }}
                >
                    {renderHighlightedCode(value)}
                </div>
                <textarea
                    ref={textareaRef}
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    onScroll={(e) => {
                        const backdrop = e.target.previousSibling;
                        if (backdrop) backdrop.scrollTop = e.target.scrollTop;
                    }}
                    placeholder={placeholder}
                    spellCheck="false"
                    className="absolute inset-0 w-full h-full p-4 bg-transparent text-white/90 outline-none resize-none caret-purple-500 whitespace-pre-wrap break-all overflow-y-auto custom-scrollbar"
                />
            </div>
        </div>
    );
};

const DiffViewer = ({ chunks, label, className = "" }) => {
    const contentRef = useRef(null);
    const linesRef = useRef(null);
    const fullText = chunks.map(c => c.content).join('');

    const lineMetadata = useMemo(() => {
        const metadata = {};
        let lineIdx = 0;
        chunks.forEach((chunk, i) => {
            const lines = chunk.content.split('\n');
            const hasNext = i < chunks.length - 1;
            const hasPrev = i > 0;
            const isModified = (chunk.type === 'removed' && hasNext && chunks[i+1].type === 'added') || 
                               (chunk.type === 'added' && hasPrev && chunks[i-1].type === 'removed');
            const status = isModified ? 'modified' : chunk.type;
            lines.forEach((_, subIdx) => {
                if (status !== 'unchanged') metadata[lineIdx + subIdx] = status;
            });
            lineIdx += lines.length - 1;
        });
        return metadata;
    }, [chunks]);

    const handleScroll = () => {
        if (linesRef.current && contentRef.current) {
            linesRef.current.scrollTop = contentRef.current.scrollTop;
        }
    };

    return (
        <div className={`flex flex-col flex-1 h-full bg-[var(--bg-main)]  border-[var(--border-color)] overflow-hidden min-w-0 ${className}`}>
            <div className="px-4 py-2  -[var(--border-color)] bg-[var(--bg-header)] flex justify-between items-center">
                <span className="text-[10px] font-black uppercase tracking-widest text-emerald-400">{label}</span>
                <span className="text-[10px] text-[var(--text-dim)] font-mono">{fullText.split('\n').length} lines</span>
            </div>
            
            <div className="flex-1 flex overflow-hidden relative">
                <LineNumbers text={fullText} scrollRef={linesRef} lineMetadata={lineMetadata} />
                <div 
                    ref={contentRef}
                    onScroll={handleScroll}
                    className="flex-1 bg-transparent p-4 font-mono text-xs outline-none resize-none whitespace-pre overflow-auto custom-scrollbar"
                    style={{ lineHeight: '1.5rem' }}
                >
                    {chunks.map((chunk, i) => (
                        <span key={i} className={`
                            ${chunk.type === 'removed' ? 'bg-red-500/20 text-red-300 line-through decoration-red-500/50' : ''}
                            ${chunk.type === 'added' ? 'bg-emerald-500/20 text-emerald-300' : 'text-slate-400'}
                        `}>
                            {chunk.content}
                        </span>
                    ))}
                </div>
            </div>
        </div>
    );
};

// --- MAIN APP ---

export default function App() {
    const [nzss, setNzss] = useState(`@ TARGET: FUNCTION exampleFunction\n@ ACTION: REPLACE_BODY\n  console.log("This body was replaced by ZeroPatch!");\n  return true;\n@ END\n\n@ TARGET: SECTION\n@ REPLACED:\n// SECTION TO REPLACE\nfunction dummy() {\n  return 0;\n}\n@ NEWCONTENT:\n// REPLACED SECTION\nfunction smartTarget() {\n  return 1;\n}\n@ END`);
    const [baseCode, setBaseCode] = useState(`function exampleFunction() {\n  console.log("Original body");\n  return false;\n}\n\nconst someOtherVar = 42;\n\n// SECTION TO REPLACE\nfunction dummy() {\n  return 0;\n}`);
    const [activeTab, setActiveTab] = useState('preview');
    const [lastChangedLines, setLastChangedLines] = useState([]);
    const [syntaxLang, setSyntaxLang] = useState('js');

    const { patchedCode, chunks, patchCount, appliedMods, targetOffsets } = useMemo(() => {
        return applySemanticPatch(baseCode, nzss);
    }, [baseCode, nzss]);

    const previewLines = useMemo(() => {
        const lines = new Set();
        targetOffsets.forEach(mod => {
            const startLine = baseCode.substring(0, mod.start).split('\n').length - 1;
            const endLine = baseCode.substring(0, mod.end).split('\n').length - 1;
            for (let i = startLine; i <= endLine; i++) lines.add(i);
        });
        return Array.from(lines);
    }, [baseCode, targetOffsets]);

    const executePatch = () => {
        if (patchCount === 0) return;
        const changedIndices = new Set();
        appliedMods.forEach(mod => {
            const startLine = patchedCode.substring(0, mod.start).split('\n').length - 1;
            const endLine = patchedCode.substring(0, mod.end).split('\n').length - 1;
            for (let i = startLine; i <= endLine; i++) changedIndices.add(i);
        });
        setLastChangedLines(Array.from(changedIndices));
        setBaseCode(patchedCode);
        setActiveTab('edit'); 
    };

    const copyPatchedText = () => {
        if (!patchedCode) return;
        const el = document.createElement('textarea');
        el.value = patchedCode;
        document.body.appendChild(el);
        el.select();
        document.execCommand('copy');
        document.body.removeChild(el);
    };

    const supportedLangs = ['js', 'nix', 'rust', 'c', 'asm', 'html', 'svelte', 'css', 'scss', 'md', 'lua'];

    return (
        <div className="flex flex-col h-screen bg-[var(--bg-surface)] text-[var(--text-main)] overflow-hidden font-sans">
            <style dangerouslySetInnerHTML={{ __html: `
                @import url('https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible+Next:ital,wght@0,200..800;1,200..800&family=Atkinson+Hyperlegible+Mono:ital,wght@0,200..800;1,200..800&display=swap');
                
                :root {
                    --bg-surface: #242424;
                    --bg-header: #2d2d2d;
                    --bg-main: #1e1e1e;
                    --bg-card: #2a2a2a;
                    --bg-popover: #353535;
                    --border-color: rgba(255, 255, 255, 0.08);
                    --accent-primary: #3584e4;
                    --text-main: #ffffff;
                    --text-dim: #9a9a9a;
                    --radius: 8px;
                }

                * { font-family: 'Atkinson Hyperlegible Next', sans-serif; outline: none !important; }
                .font-mono, .font-mono * { font-family: 'Atkinson Hyperlegible Mono', monospace !important; }

                .custom-scrollbar::-webkit-scrollbar { width: 8px; height: 8px; }
                .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
                .custom-scrollbar::-webkit-scrollbar-thumb { background: #353535; border-radius: 4px; }
                .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #404040; }

                .view-switcher-pill {
                    background: var(--bg-card);
                    border-radius: 100px;
                    padding: 4px;
                    display: flex;
                    gap: 2px;
                }

                .view-switcher-btn {
                    padding: 4px 16px;
                    border-radius: 100px;
                    font-size: 11px;
                    font-weight: 700;
                    text-transform: uppercase;
                    letter-spacing: 0.05em;
                    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
                    color: var(--text-dim);
                    border: none;
                    background: transparent;
                }

                .view-switcher-btn.active {
                    background: var(--bg-popover);
                    color: var(--text-main);
                }

                .adw-header-bar {
                    height: 56px;
                    padding: 0 16px;
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                }

                .adw-btn {
                    height: 34px;
                    padding: 0 16px;
                    border-radius: var(--radius);
                    font-size: 12px;
                    font-weight: 700;
                    transition: all 0.2s;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 8px;
                    background: transparent;
                    color: var(--text-dim);
                    border: none;
                }

                .adw-btn:hover:not(:disabled) {
                    background: var(--bg-popover);
                    color: var(--text-main);
                }
                
                .adw-btn:disabled { 
                    opacity: 0.5; 
                    cursor: not-allowed; 
                }

                .adw-view-pane {
                    margin: 10px;
                    border-radius: var(--radius);
                    box-shadow: 0 10px 40px rgba(0,0,0,0.3);
                    overflow: hidden;
                }
            `}} />

            {/* HEADER BAR */}
            <header className="adw-header-bar">
                <div className="flex items-center gap-4">
                    <div className="flex items-center">
                        <select 
                            value={syntaxLang} 
                            onChange={e => setSyntaxLang(e.target.value)}
                            className="adw-btn appearance-none cursor-pointer text-center uppercase font-bold"
                            style={{ paddingRight: '16px' }}
                        >
                            {supportedLangs.map(lang => <option key={lang} value={lang}>{lang}</option>)}
                        </select>
                    </div>
                </div>

                <div className="absolute left-1/2 -translate-x-1/2">
                    <div className="view-switcher-pill">
                        <button 
                            onClick={() => setActiveTab('edit')}
                            className={`view-switcher-btn ${activeTab === 'edit' ? 'active' : ''}`}
                        >
                            Source
                        </button>
                        <button 
                            onClick={() => setActiveTab('preview')}
                            className={`view-switcher-btn ${activeTab === 'preview' ? 'active' : ''}`}
                        >
                            Preview
                        </button>
                    </div>
                </div>

                <div className="flex items-center gap-1">
                    <button 
                        onClick={copyPatchedText}
                        disabled={patchCount === 0}
                        className="adw-btn"
                    >
                        Copy
                    </button>
                    <button 
                        onClick={executePatch}
                        disabled={patchCount === 0}
                        className="adw-btn"
                    >
                        Apply Changes
                    </button>
                </div>
            </header>

            {/* MAIN CONTENT */}
            <main className="flex-1 flex gap-2 p-2 overflow-hidden bg-[var(--bg-surface)]">
                <div className="w-1/2 flex flex-col h-full overflow-hidden">
                    <CodeEditor 
                        label="NZSS Patch" 
                        value={nzss} 
                        onChange={setNzss} 
                        colorClass="text-purple-400"
                        placeholder="@ TARGET: FUNCTION name\n@ ACTION: REPLACE_BODY\n{...}\n@ END"
                        className="rounded-xl shadow-2xl"
                    />
                </div>
                
                <div className="w-1/2 flex flex-col h-full overflow-hidden">
                    {activeTab === 'edit' ? (
                        <CodeEditor 
                            label="Target File" 
                            value={baseCode} 
                            onChange={(val) => { setBaseCode(val); setLastChangedLines([]); }} 
                            colorClass="text-[var(--text-dim)]"
                            placeholder="Paste code here..."
                            className="rounded-xl shadow-2xl"
                            changedLines={lastChangedLines}
                            previewLines={previewLines}
                            language={syntaxLang}
                        />
                    ) : (
                        <DiffViewer 
                            chunks={chunks} 
                            label={patchCount > 0 ? "Pending Changes" : "No Targets"} 
                            className="rounded-xl shadow-2xl"
                        />
                    )}
                </div>
            </main>

        </div>
    );
}

