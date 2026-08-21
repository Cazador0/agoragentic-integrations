/**
 * Markdown editing pane: a thin, app-shaped wrapper around a CodeMirror 6
 * EditorView. It owns the buffer and the dirty bookkeeping; deciding when to
 * open, save, reload or close a note is the app shell's job.
 */

import { EditorState } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLine, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';

/** Must stay identical to the style-src nonce in renderer/index.html: with a
 * strict CSP the <style> element CodeMirror mounts its theme into is rejected
 * unless it carries this nonce. */
const EDITOR_STYLE_NONCE = 'notegraph-editor-styles';

const MONOSPACE_STACK =
  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";

const EDITOR_THEME = EditorView.theme(
  {
    '&': {
      height: '100%',
      backgroundColor: '#16161c',
      color: '#c9c9d4',
      fontSize: '13px',
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': {
      fontFamily: MONOSPACE_STACK,
      lineHeight: '1.55',
      overflow: 'auto',
    },
    '.cm-content': {
      padding: '10px 14px 40vh',
      caretColor: '#7c5cff',
    },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#7c5cff' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: 'rgba(124, 92, 255, 0.30)',
    },
    '.cm-activeLine': { backgroundColor: 'rgba(255, 255, 255, 0.035)' },
    '.cm-selectionMatch': { backgroundColor: 'rgba(124, 92, 255, 0.22)' },
    '.cm-searchMatch': { backgroundColor: 'rgba(224, 175, 104, 0.28)' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'rgba(124, 92, 255, 0.45)' },
    '.cm-panels': { backgroundColor: '#1b1b23', color: '#c9c9d4' },
    '.cm-panels.cm-panels-top': { borderBottom: '1px solid rgba(255, 255, 255, 0.09)' },
    '.cm-panel input, .cm-panel button': {
      backgroundColor: 'rgba(255, 255, 255, 0.05)',
      color: '#c9c9d4',
      border: '1px solid rgba(255, 255, 255, 0.09)',
      borderRadius: '4px',
    },
  },
  { dark: true },
);

export interface NoteEditorCallbacks {
  onSave(path: string, content: string): void;
  onDirtyChange(dirty: boolean): void;
}

export class NoteEditor {
  private readonly view: EditorView;
  private readonly callbacks: NoteEditorCallbacks;
  private notePath: string | null = null;
  private savedContent = '';
  private dirty = false;

  constructor(parent: HTMLElement, callbacks: NoteEditorCallbacks) {
    this.callbacks = callbacks;
    this.view = new EditorView({ parent, state: this.createState('') });
  }

  /** Loads `content` as the buffer for `path`, discarding any previous buffer
   * and its undo history. */
  open(notePath: string, content: string): void {
    this.notePath = notePath;
    this.view.setState(this.createState(content));
    this.savedContent = this.view.state.doc.toString();
    this.setDirty(false);
    // The pane is display:none until a note opens, so CodeMirror's cached
    // geometry is stale the first time it becomes visible.
    this.view.requestMeasure();
  }

  getContent(): string {
    return this.view.state.doc.toString();
  }

  /** The open note's vault-relative path, or null when nothing is open. */
  getPath(): string | null {
    return this.notePath;
  }

  isDirty(): boolean {
    return this.dirty;
  }

  /** Adopts the current buffer as the on-disk baseline. */
  markSaved(): void {
    this.savedContent = this.view.state.doc.toString();
    this.setDirty(false);
  }

  /** Replaces the buffer with content that came from disk, preserving the
   * cursor. A no-op when the buffer already matches, so an echo of our own
   * write never disturbs the caret or the scroll position. */
  applyExternalContent(content: string): void {
    if (this.view.state.doc.toString() === content) {
      this.savedContent = content;
      this.setDirty(false);
      return;
    }
    const previousSelection = this.view.state.selection.main;
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: content },
      scrollIntoView: false,
    });
    const limit = this.view.state.doc.length;
    this.view.dispatch({
      selection: {
        anchor: Math.min(previousSelection.anchor, limit),
        head: Math.min(previousSelection.head, limit),
      },
      scrollIntoView: false,
    });
    this.savedContent = this.view.state.doc.toString();
    this.setDirty(false);
  }

  close(): void {
    this.notePath = null;
    this.view.setState(this.createState(''));
    this.savedContent = '';
    this.setDirty(false);
  }

  focus(): void {
    this.view.focus();
  }

  private createState(doc: string): EditorState {
    return EditorState.create({ doc, extensions: this.buildExtensions() });
  }

  private buildExtensions(): Extension[] {
    return [
      history(),
      drawSelection(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search({ top: true }),
      markdown(),
      EditorView.lineWrapping,
      EDITOR_THEME,
      EditorView.cspNonce.of(EDITOR_STYLE_NONCE),
      keymap.of([
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => {
            this.requestSave();
            return true;
          },
        },
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
      ]),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        const doc = update.state.doc;
        if (this.notePath === null) {
          this.setDirty(false);
        } else if (doc.length !== this.savedContent.length) {
          this.setDirty(true);
        } else {
          this.setDirty(doc.toString() !== this.savedContent);
        }
      }),
    ];
  }

  private requestSave(): void {
    if (this.notePath === null) return;
    this.callbacks.onSave(this.notePath, this.getContent());
  }

  private setDirty(dirty: boolean): void {
    if (this.dirty === dirty) return;
    this.dirty = dirty;
    this.callbacks.onDirtyChange(dirty);
  }
}
