import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../assets/editor.js", import.meta.url), "utf8");
const modelSource = readFileSync(new URL("../assets/editor-model.js", import.meta.url), "utf8");
const commandSource = readFileSync(new URL("../assets/features/lazy/block-commands.js", import.meta.url), "utf8");
const selectionSource = readFileSync(new URL("../assets/features/lazy/editor-selection.js", import.meta.url), "utf8");
const cut = (from: string, to: string) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
const undo = cut("  var undoStack = [],", "  function save() {");
const wire = cut("  function wireText(", "  // The next block in the given direction");
const near = cut("  function nearText(", "  function columnTemplate(");
const focus = cut("  function focusBlock(", "  function dbRefBlock(");
const moves = cut("  function duplicate(index)", "  function indent(index, delta)");

let browser: Bun.WebView;
beforeAll(async () => {
  browser = new Bun.WebView();
  await browser.navigate("about:blank");
  await browser.evaluate(`(() => {
    ${modelSource}
    document.body.innerHTML = '<div id="blocks"></div>';
    window.model = EditorModel;
    window.selectedIds = new Set();
    window.els = { blocks: document.getElementById('blocks'), slash: { hidden: true } };
    window.cm = { columnOf: () => null, canIndent: () => true };
    window.structure = blocks => blocks;
    window.coreEditing = false;
    window.slashes = 0;
    window.openSlash = () => slashes++;
    window.hideSlash = () => {};
    window.loadEasy = () => Promise.resolve();
    window.subpagesOf = () => []; window.syncSubpages = () => {};
    window.paintTocs = () => {}; window.emitFeature = () => {}; window.setSave = () => {};
    window.save = () => Promise.resolve();
    window.palettes = [];
    window.humanEdit = () => document.documentElement.getAttribute('data-human-edit') === 'on';
    window.easy = null; window.formatContext = null; window.slashIndex = -1; window.startupEdited = false;
    let n = 0;
    window.uid = () => 'c' + (++n);
    window.newBlock = (type) => ({ id: uid(), type: type || 'paragraph', text: '', checked: false, indent: 0, meta: null });
    window.render = () => {
      els.blocks.innerHTML = '';
      state.blocks.forEach((block, index) => {
        const row = document.createElement('div'); row.className = 'blk'; row.dataset.id = block.id; row.id = 'block-' + block.id;
        row.dataset.index = String(index);
        const text = document.createElement('div'); text.className = 'text'; text.contentEditable = 'true'; text.textContent = block.text;
        row.appendChild(text); els.blocks.appendChild(row); wireText(text, block, row, index);
      });
    };
    let saveTimer = null, hasToc = false;
    ${undo}${wire}${near}${focus}${moves}
    window.wireText = wireText; window.restoreEdit = restoreEdit; window.undoStack = undoStack;
    Object.defineProperty(window, 'redoStack', { get: () => redoStack });
    window.transact = transact; window.scheduleSave = scheduleSave;
    window.captureSelection = captureSelection;
    window.lazy = (name) => name === 'tab-palette'
      ? Promise.resolve({ open: (id) => palettes.push(id) })
      : Promise.resolve(AcardEditor.commands);
    window.loadEditing = () => Promise.resolve();
    window.runBlockCommand = (name, args) => AcardEditor.commands[name](...args);
    window.ColumnsModel = cm;
    window.AcardEditor = { get state() { return state; }, transact, captureSelection, createBlock: newBlock, provide(name,api) { if(name==='editor-selection') selectionTools=api; }, selectBlocks(ids) { selectedIds.clear(); ids.forEach(id => selectedIds.add(id)); }, getSelection() { return { blockIds: Array.from(selectedIds) }; } };
    ${selectionSource}
    ${commandSource}
    window.reset = (firstText = 'one') => {
      window.state = { title: 'T', blocks: [
        { id: 'a', type: 'paragraph', text: firstText, indent: 0, meta: null },
        { id: 'b', type: 'to_do', text: 'two', indent: 0, meta: null, checked: true },
        { id: 'b1', type: 'paragraph', text: 'child', indent: 1, meta: null },
        { id: 'c', type: 'heading2', text: 'three', indent: 0, meta: null }
      ] };
      coreEditing = false; selectedIds.clear(); undoStack.length = 0; redoStack.length = 0; previousSnapshot = snapshot(); render();
    };
    window.press = (id, init) => {
      const text = els.blocks.querySelector('[data-id="' + id + '"] .text');
      text.focus();
      const ev = new KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, init));
      text.dispatchEvent(ev);
      clearTimeout(saveTimer);
      return ev.defaultPrevented;
    };
    window.view = () => ({
      ids: state.blocks.map(b => b.id), indents: state.blocks.map(b => b.indent),
      focused: document.activeElement && document.activeElement.closest('.blk') ? document.activeElement.closest('.blk').dataset.id : null
    });
  })()`);
}, 20000);
afterAll(() => browser.close());

test("Enter, Backspace and input shortcuts do nothing while an IME composition is in progress", async () => {
  expect(await browser.evaluate(`(() => {
    reset();
    const prevented = press('a', { key: 'Enter', isComposing: true, keyCode: 229 });
    const after229 = press('a', { key: 'Enter', keyCode: 229 });
    const enter = state.blocks.length;
    reset(); state.blocks[0].text = ''; render();
    const back = press('a', { key: 'Backspace', isComposing: true, keyCode: 229 });
    const backspace = state.blocks.length;
    reset();
    const text = els.blocks.querySelector('[data-id="a"] .text');
    text.textContent = '/';
    text.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
    return { prevented, after229, enter, back, backspace, slashes };
  })()`)).toEqual({ prevented: false, after229: false, enter: 4, back: false, backspace: 4, slashes: 0 });
});

test("Tab on an empty top-level line opens the feature palette; list items and lines with text still indent (acard-human-edit)", async () => {
  expect(await browser.evaluate(`(async () => {
    reset(); palettes.length = 0;
    document.documentElement.removeAttribute('data-human-edit');
    state.blocks.push({ id: 'off', type: 'paragraph', text: '', indent: 0, meta: null }); render();
    press('off', { key: 'Tab' });
    await Promise.resolve(); await Promise.resolve();
    const flagOff = { palettes: palettes.length, indent: state.blocks.find(b => b.id === 'off').indent };
    reset(); palettes.length = 0;
    document.documentElement.setAttribute('data-human-edit', 'on');
    state.blocks.push({ id: 'e', type: 'paragraph', text: '', indent: 0, meta: null }, { id: 'l', type: 'bulleted', text: '', indent: 0, meta: null });
    render();
    const emptyLine = press('e', { key: 'Tab' });
    await Promise.resolve(); await Promise.resolve();
    const opened = palettes.slice();
    const indentsAfterPalette = view().indents;
    press('l', { key: 'Tab' });
    const listIndent = state.blocks.find(b => b.id === 'l').indent;
    press('c', { key: 'Tab' });
    const textIndent = state.blocks.find(b => b.id === 'c').indent;
    const composing = press('e', { key: 'Tab', isComposing: true, keyCode: 229 });
    return { flagOff, emptyLine, opened, indentsAfterPalette, listIndent, textIndent, composing, palettesAfter: palettes.length };
  })()`)).toEqual({ flagOff: { palettes: 0, indent: 1 }, emptyLine: true, opened: ["e"], indentsAfterPalette: [0, 0, 1, 0, 0, 0], listIndent: 1, textIndent: 1, composing: false, palettesAfter: 1 });
});

test("Ctrl+D duplicates the block below it with its children, focuses the copy, and Ctrl+Z undoes it", async () => {
  expect(await browser.evaluate(`(() => {
    reset();
    const prevented = press('b', { key: 'd', ctrlKey: true });
    const copy = state.blocks[3];
    const after = Object.assign(view(), { copy: { type: copy.type, text: copy.text, indent: copy.indent, checked: copy.checked }, child: state.blocks[4].text });
    restoreEdit(undoStack, redoStack);
    return { prevented, after, undone: view().ids };
  })()`)).toEqual({
    prevented: true,
    after: { ids: ["a", "b", "b1", "c1", "c2", "c"], indents: [0, 0, 1, 0, 1, 0], focused: "c1", copy: { type: "to_do", text: "two", indent: 0, checked: true }, child: "child" },
    undone: ["a", "b", "b1", "c"],
  });
});

test("Ctrl+Shift+ArrowUp/Down move the block among its siblings, keep the caret in it, and Ctrl+Z undoes it", async () => {
  expect(await browser.evaluate(`(() => {
    reset();
    const up = press('c', { key: 'ArrowUp', ctrlKey: true, shiftKey: true });
    const afterUp = view();
    const down = press('a', { key: 'ArrowDown', metaKey: true, shiftKey: true });
    const afterDown = view();
    press('b1', { key: 'ArrowUp', ctrlKey: true, shiftKey: true });
    const child = view();
    const top = press('c', { key: 'ArrowUp', ctrlKey: true, shiftKey: true });
    restoreEdit(undoStack, redoStack);
    return { up, afterUp, down, afterDown, child, top, undone: view().ids };
  })()`)).toEqual({
    up: true,
    afterUp: { ids: ["a", "c", "b", "b1"], indents: [0, 0, 0, 1], focused: "c" },
    child: { ids: ["c", "a", "b", "b1"], indents: [0, 0, 0, 1], focused: "b1" },
    down: true,
    afterDown: { ids: ["c", "a", "b", "b1"], indents: [0, 0, 0, 1], focused: "a" },
    top: true,
    undone: ["a", "c", "b", "b1"],
  });
});

test("nested edits undo together and restore a backward text selection", async () => {
  expect(await browser.evaluate(`(() => {
    reset();
    const text = els.blocks.querySelector('[data-id="a"] .text');
    text.focus(); getSelection().setBaseAndExtent(text.firstChild, 3, text.firstChild, 1);
    transact('bulk edit', () => {
      state.blocks[0].text = 'changed'; scheduleSave();
      transact('nested', () => { state.blocks[1].text = 'changed too'; scheduleSave(); });
    });
    const steps = undoStack.length;
    restoreEdit(undoStack, redoStack);
    return { steps, texts: state.blocks.slice(0,2).map(b => b.text), anchor: getSelection().anchorOffset, focus: getSelection().focusOffset };
  })()`)).toEqual({ steps: 1, texts: ['one', 'two'], anchor: 3, focus: 1 });
});

test("a caught nested transaction failure rolls back without history or saving", async () => {
  expect(await browser.evaluate(`(() => {
    reset(); let failure = '';
    try {
      transact('outer', () => {
        state.blocks[0].text = 'lost'; scheduleSave();
        try { transact('inner', () => { throw Error('abort'); }); } catch {}
        state.blocks[1].text = 'also lost';
      });
    } catch (error) { failure = error.message; }
    return { failure, texts: state.blocks.slice(0,2).map(b => b.text), steps: undoStack.length, dirty: !!state.dirty };
  })()`)).toEqual({ failure: 'abort', texts: ['one', 'two'], steps: 0, dirty: false });
});

test("a no-op transaction creates no undo step", async () => {
  expect(await browser.evaluate(`(() => { reset(); const changed = transact('no-op', () => scheduleSave()); return { changed, steps: undoStack.length, dirty: !!state.dirty }; })()`))
    .toEqual({ changed: false, steps: 0, dirty: false });
});

test("redo restores the transaction result and its caret", async () => {
  expect(await browser.evaluate(`(() => {
    reset();
    transact('replace', tx => {
      state.blocks[0].text = 'replacement';
      tx.setSelection({ anchor: {kind:'text',blockId:'a',offset:4}, focus: {kind:'text',blockId:'a',offset:4}, selectedBlockIds:[] });
    });
    restoreEdit(undoStack, redoStack);
    restoreEdit(redoStack, undoStack);
    return { text: state.blocks[0].text, offset: getSelection().anchorOffset, steps: undoStack.length };
  })()`)).toEqual({ text: 'replacement', offset: 4, steps: 1 });
});

test("async transaction callbacks are rejected before they can mutate the document", async () => {
  expect(await browser.evaluate(`(() => {
    reset(); let message = '';
    try { transact('async', async () => { state.blocks[0].text = 'wrong'; }); }
    catch (error) { message = error.message; }
    return { text: state.blocks[0].text, rejected: message.includes('synchronous'), steps: undoStack.length };
  })()`)).toEqual({ text: 'one', rejected: true, steps: 0 });
});

test("shared split and merge commands conserve text and undo as individual actions", async () => {
  expect(await browser.evaluate(`(() => {
    reset('AlphaBravo');
    const selection = {anchor:{kind:'text',blockId:'a',offset:5},focus:{kind:'text',blockId:'a',offset:5},selectedBlockIds:[]};
    AcardEditor.commands.splitBlock('a',selection);
    const split = state.blocks.slice(0,2).map(b => b.text), next = state.blocks[1].id;
    AcardEditor.commands.mergeBlocks(['a',next]);
    const merged = state.blocks[0].text;
    restoreEdit(undoStack,redoStack);
    const undoMerge = state.blocks.slice(0,2).map(b => b.text);
    restoreEdit(undoStack,redoStack);
    return {split,merged,undoMerge,original:state.blocks[0].text};
  })()`)).toEqual({split:['Alpha','Bravo'],merged:'AlphaBravo',undoMerge:['Alpha','Bravo'],original:'AlphaBravo'});
});

test("shared bulk duplication counts selected descendants only once", async () => {
  expect(await browser.evaluate(`(() => {
    reset(); AcardEditor.commands.duplicateBlocks(['b','b1']);
    return {texts:state.blocks.map(b=>b.text), unique:new Set(state.blocks.map(b=>b.id)).size, steps:undoStack.length};
  })()`)).toEqual({texts:['one','two','child','two','child','three'],unique:6,steps:1});
});

test("bulk color colors every selected root in one undo step and default clears it", async () => {
  expect(await browser.evaluate(`(() => {
    reset(); AcardEditor.commands.colorBlocks(['a','b'],'blue_background');
    const colored = state.blocks.map(b=>(b.meta&&b.meta.color)||null), steps = undoStack.length;
    restoreEdit(undoStack,redoStack);
    const undone = state.blocks.map(b=>(b.meta&&b.meta.color)||null);
    AcardEditor.commands.colorBlocks(['a'],'red'); AcardEditor.commands.colorBlocks(['a'],'default');
    return {colored, steps, undone, cleared:(state.blocks[0].meta&&state.blocks[0].meta.color)||null};
  })()`)).toEqual({colored:['blue_background','blue_background',null,null],steps:1,undone:[null,null,null,null],cleared:null});
});

test("bulk type change converts every selected root, keeps text and children, in one undo step", async () => {
  expect(await browser.evaluate(`(() => {
    reset(); AcardEditor.commands.setTypeBlocks(['a','b'],'heading2');
    const after = state.blocks.map(b=>[b.type,b.text,b.indent||0]), steps = undoStack.length;
    restoreEdit(undoStack,redoStack);
    return {after, steps, undone:state.blocks.map(b=>b.type)};
  })()`)).toEqual({after:[['heading2','one',0],['heading2','two',0],['paragraph','child',1],['heading2','three',0]],steps:1,undone:['paragraph','to_do','paragraph','heading2']});
});

test("plain paste keeps Markdown punctuation and soft lines literal", async () => {
  expect(await browser.evaluate(`(() => {
    reset(); const selection={anchor:{kind:'text',blockId:'a',offset:1},focus:{kind:'text',blockId:'a',offset:2},selectedBlockIds:[]};
    AcardEditor.commands.pastePlain('**literal**\\n# plain',selection);
    return {text:state.blocks[0].text,type:state.blocks[0].type,count:state.blocks.length,steps:undoStack.length};
  })()`)).toEqual({text:'o**literal**\n# plaine',type:'paragraph',count:4,steps:1});
});

test("QA mode routes top-level Tab to the palette while preserving list indentation", async () => {
  expect(await browser.evaluate(`(async () => {
    reset(''); coreEditing = true; palettes.length = 0;
    document.documentElement.setAttribute('data-human-edit','on');
    const prevented = press('a',{key:'Tab'});
    await Promise.resolve(); await Promise.resolve();
    press('b',{key:'Tab'});
    return {prevented,palette:palettes.slice(),paragraph:state.blocks[0].indent,list:state.blocks[1].indent,child:state.blocks[2].indent};
  })()`)).toEqual({prevented:true,palette:['a'],paragraph:0,list:1,child:2});
});

test("QA mode Enter splits at the real caret without intercepting IME", async () => {
  expect(await browser.evaluate(`(() => {
    reset('AlphaBravo'); coreEditing=true;
    const text=els.blocks.querySelector('[data-id="a"] .text');text.focus();getSelection().setBaseAndExtent(text.firstChild,5,text.firstChild,5);
    text.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
    const split=state.blocks.slice(0,2).map(b=>b.text);
    press('b',{key:'Enter',isComposing:true,keyCode:229});
    return {split,count:state.blocks.length};
  })()`)).toEqual({split:['Alpha','Bravo'],count:5});
});

test("shared command registration preserves human-edit menu commands", async () => {
  expect(await browser.evaluate(`(() => {
    const same = AcardEditor.commands;
    const comment = () => 'human comment';
    same.comment = comment;
    ${commandSource}
    reset(); const duplicate=AcardEditor.commands.duplicate('a');
    return {same:AcardEditor.commands===same,comment:AcardEditor.commands.comment(),duplicateText:duplicate.text,duplicateId:typeof duplicate.id};
  })()`)).toEqual({same:true,comment:'human comment',duplicateText:'one',duplicateId:'string'});
});

test("block range selection can extend then shrink without losing its anchor", async () => {
  expect(await browser.evaluate(`(() => {
    reset(); const c=AcardEditor.commands;
    c.selectBlocks(['b']);
    c.blockKey({key:'ArrowDown',shiftKey:true,target:els.blocks,preventDefault(){}});
    const extended=Array.from(selectedIds);
    c.blockKey({key:'ArrowUp',shiftKey:true,target:els.blocks,preventDefault(){}});
    return {extended,shrunk:Array.from(selectedIds)};
  })()`)).toEqual({extended:['b','b1'],shrunk:['b']});
});

test("splitting preserves block AI scope and merging different scopes is refused", async () => {
  expect(await browser.evaluate(`(() => {
    reset('AlphaBravo'); state.blocks[0].meta={ai:'lock'};
    const s={anchor:{kind:'text',blockId:'a',offset:5},focus:{kind:'text',blockId:'a',offset:5},selectedBlockIds:[]};
    AcardEditor.commands.splitBlock('a',s);
    const marks=state.blocks.slice(0,2).map(b=>b.meta.ai), next=state.blocks[1].id;
    state.blocks[1].meta.ai='ref';
    const merged=AcardEditor.commands.mergeBlocks(['a',next]);
    return {marks,merged,texts:state.blocks.slice(0,2).map(b=>b.text)};
  })()`)).toEqual({marks:['lock','lock'],merged:false,texts:['Alpha','Bravo']});
});

test("structured paste preserves caret prefix, pasted hierarchy and suffix in one undo", async () => {
  expect(await browser.evaluate(`(() => {
    reset('AlphaBravo');
    const s={anchor:{kind:'text',blockId:'a',offset:5},focus:{kind:'text',blockId:'a',offset:5},selectedBlockIds:[]};
    AcardEditor.commands.insertBlocks([{type:'bulleted',text:'Pasted',indent:0},{type:'paragraph',text:'Nested',indent:1}],s);
    const result=state.blocks.slice(0,4).map(b=>[b.text,b.indent]);
    restoreEdit(undoStack,redoStack);
    return {result,original:state.blocks[0].text,count:state.blocks.length};
  })()`)).toEqual({result:[['Alpha',0],['Pasted',0],['Nested',1],['Bravo',0]],original:'AlphaBravo',count:4});
});

test("an external edit keeps its history entry until the guarded server undo resolves", async () => {
  expect(await browser.evaluate(`(async () => {
    reset(); let complete; const pending=new Promise(resolve=>complete=resolve);
    undoStack.push({run:()=>pending});
    restoreEdit(undoStack,redoStack);
    const during={undo:undoStack.length,redo:redoStack.length};
    complete(); await pending; await Promise.resolve();
    return {during,after:{undo:undoStack.length,redo:redoStack.length}};
  })()`)).toEqual({during:{undo:1,redo:0},after:{undo:0,redo:1}});
});

test("moving a subtree beyond supported depth is refused without flattening children", async () => {
  expect(await browser.evaluate(`(() => {
    reset(); state.blocks[3].indent=6;
    const before=JSON.stringify(state.blocks);
    const changed=AcardEditor.commands.moveBlocks(['b'],{parentId:'c'});
    return {changed,same:JSON.stringify(state.blocks)===before,steps:undoStack.length};
  })()`)).toEqual({changed:false,same:true,steps:0});
});

test("split and merge retain rich runs and all characters at the boundary", async () => {
  expect(await browser.evaluate(`(() => {
    reset('AlphaBravo');state.blocks[0].meta={richText:[{text:'Alpha',bold:true},{text:'Bravo',href:'https://example.test/'}]};
    const s={anchor:{kind:'text',blockId:'a',offset:5},focus:{kind:'text',blockId:'a',offset:5},selectedBlockIds:[]};
    AcardEditor.commands.splitBlock('a',s);const split=state.blocks.slice(0,2).map(b=>b.meta.richText);
    AcardEditor.commands.mergeBlocks(['a',state.blocks[1].id]);
    return{split,runs:state.blocks[0].meta.richText,text:state.blocks[0].text};
  })()`)).toEqual({split:[[{text:'Alpha',bold:true}],[{text:'Bravo',href:'https://example.test/'}]],runs:[{text:'Alpha',bold:true},{text:'Bravo',href:'https://example.test/'}],text:'AlphaBravo'});
});

test("Backspace on an empty top-level parent keeps its child block", async () => {
  expect(await browser.evaluate(`(() => {
    reset(); coreEditing=true; state.blocks[1].type='paragraph'; state.blocks[1].text=''; render();
    const text=document.querySelector('[data-id="b"] .text');text.focus();getSelection().setBaseAndExtent(text,0,text,0);
    const event=new KeyboardEvent('keydown',{key:'Backspace',bubbles:true,cancelable:true});text.dispatchEvent(event);
    return {prevented:event.defaultPrevented,texts:state.blocks.map(b=>b.text)};
  })()`)).toEqual({prevented:true,texts:['one','child','three']});
});

test("the classic Backspace on an empty parent (core editing off or not yet loaded) keeps its child", async () => {
  expect(await browser.evaluate(`(() => {
    reset(); coreEditing=false; state.blocks[1].type='paragraph'; state.blocks[1].text=''; render();
    const text=document.querySelector('[data-id="b"] .text');text.focus();getSelection().setBaseAndExtent(text,0,text,0);
    const event=new KeyboardEvent('keydown',{key:'Backspace',bubbles:true,cancelable:true});text.dispatchEvent(event);
    const keptParent=state.blocks.map(b=>b.text);
    state.blocks.splice(2,1); render();
    const leaf=document.querySelector('[data-id="b"] .text');leaf.focus();getSelection().setBaseAndExtent(leaf,0,leaf,0);
    leaf.dispatchEvent(new KeyboardEvent('keydown',{key:'Backspace',bubbles:true,cancelable:true}));
    return {prevented:event.defaultPrevented,keptParent,leafRemoved:state.blocks.map(b=>b.text)};
  })()`)).toEqual({prevented:true,keptParent:['one','','child','three'],leafRemoved:['one','three']});
});

test("Backspace on an empty nested parent outdents without deleting its descendants", async () => {
  expect(await browser.evaluate(`(() => {
    reset(); coreEditing=true; state.blocks[1].text='';state.blocks[1].indent=1;state.blocks[2].indent=2;render();
    const text=document.querySelector('[data-id="b"] .text');text.focus();getSelection().setBaseAndExtent(text,0,text,0);
    const event=new KeyboardEvent('keydown',{key:'Backspace',bubbles:true,cancelable:true});text.dispatchEvent(event);
    return {prevented:event.defaultPrevented,ids:state.blocks.map(b=>b.id),depth:state.blocks.map(b=>b.indent),child:state.blocks[2].text};
  })()`)).toEqual({prevented:true,ids:['a','b','b1','c'],depth:[0,0,1,0],child:'child'});
});
