import Vue from 'vue';
import mirrorsharp, { MirrorSharpInstance, MirrorSharpOptions, MirrorSharpConnectionState } from 'mirrorsharp';
import 'codemirror/mode/mllike/mllike';
import type { FlowStep, Result } from '../ts/types/results';
import type { HighlightedRange } from '../ts/types/highlighted-range';
import type { ServerOptions } from '../ts/types/server-options';
import type { PartiallyMutable } from '../ts/helpers/partially-mutable';
import type { LanguageName } from '../ts/helpers/languages';
import './internal/codemirror/addon-jump-arrows';
import groupToMap from '../ts/helpers/group-to-map';
import extendType from '../ts/helpers/extend-type';

export const appCodeEditProps = {
    initialText:       String,
    initialCached:     Boolean,
    serviceUrl:        String,
    language:          String as () => LanguageName|undefined,
    serverOptions:     Object as () => ServerOptions|undefined,
    highlightedRange:  Object as () => HighlightedRange|undefined,
    executionFlow:     Array as () => Array<FlowStep>
};

export default Vue.extend({
    props: appCodeEditProps,
    data: () => extendType({})<{
        initialConnectionRequested: boolean;
        instance: MirrorSharpInstance<ServerOptions>;
    }>(),
    async mounted() {
        await Vue.nextTick();

        const textarea = this.$el as HTMLTextAreaElement;
        textarea.value = this.initialText;

        this.initialConnectionRequested = !this.initialCached;
        const connectIfInitialWasCached = () => {
            if (this.initialConnectionRequested)
                return;
            this.instance.connect();
            this.initialConnectionRequested = true;
        };

        const options = {
            serviceUrl: this.serviceUrl,
            language: this.language,
            initialServerOptions: this.serverOptions,
            noInitialConnection: this.initialCached,
            on: {
                slowUpdateWait: () => this.$emit('slow-update-wait'),
                slowUpdateResult: result => this.$emit('slow-update-result', result),
                connectionChange: (type: MirrorSharpConnectionState) => this.$emit('connection-change', type),
                textChange: getText => {
                    connectIfInitialWasCached();
                    this.$emit('text-change', getText);
                },
                serverError: message => this.$emit('server-error', message)
            }
        } as PartiallyMutable<
            MirrorSharpOptions<ServerOptions, Result['value']>,
            'language' | 'initialServerOptions' | 'serviceUrl' | 'noInitialConnection'
        >;
        // incorrect, based on type _name_ match?
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-arguments
        this.instance = mirrorsharp(textarea, options);

        const cm = this.instance.getCodeMirror();

        const contentEditable = cm
            .getWrapperElement()
            .querySelector('[contentEditable=true]');
        if (contentEditable)
            contentEditable.setAttribute('autocomplete', 'off');

        this.$watch('initialText', (v: string) => this.instance.setText(v));
        this.$watch('language', (l: LanguageName) => {
            options.language = l;
            // eslint-disable-next-line @typescript-eslint/no-floating-promises
            this.instance.setLanguage(l);
            connectIfInitialWasCached();
        }, { deep: true });
        this.$watch('serverOptions', (o: ServerOptions) => {
            options.initialServerOptions = o;
            // eslint-disable-next-line @typescript-eslint/no-floating-promises
            this.instance.setServerOptions(o);
            connectIfInitialWasCached();
        }, { deep: true });

        const recreate = () => {
            this.instance.destroy({ keepCodeMirror: true });

            options.noInitialConnection = false;
            this.initialConnectionRequested = true;
            this.instance = mirrorsharp(textarea, options);
        };
        this.$watch('serviceUrl', (u: string) => {
            options.serviceUrl = u;
            recreate();
        });

        let currentMarker: CodeMirror.TextMarker|null = null;
        this.$watch('highlightedRange', (range: HighlightedRange|undefined) => {
            if (currentMarker) {
                currentMarker.clear();
                currentMarker = null;
            }
            if (!range)
                return;

            const from = typeof range.start === 'object' ? range.start : cm.posFromIndex(range.start);
            const to   = typeof range.end === 'object'   ? range.end : cm.posFromIndex(range.end);
            currentMarker = cm.markText(from, to, { className: 'highlighted' });
        });

        const bookmarks = [] as Array<CodeMirror.TextMarker>;
        this.$watch('executionFlow', (steps: ReadonlyArray<FlowStep|number>|undefined) => renderExecutionFlow(steps ?? [], this.instance.getCodeMirror(), bookmarks));

        const getCursorOffset = () => cm.indexFromPos(cm.getCursor());
        cm.on('cursorActivity', () => this.$emit('cursor-move', getCursorOffset));
    },
    beforeDestroy() {
        // CodeMirror fails to destroy itself since textarea is already removed from DOM
        const cm = this.instance.getCodeMirror();
        this.instance.destroy({ keepCodeMirror: true });
        const wrapper = cm.getWrapperElement();
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        wrapper.parentElement!.removeChild(wrapper);
    },
    template: '<textarea></textarea>'
});

function renderExecutionFlow(steps: ReadonlyArray<FlowStep|number>, cm: CodeMirror.Editor, bookmarks: Array<CodeMirror.TextMarker>) {
    while (bookmarks.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        bookmarks.pop()!.clear();
    }

    const jumpArrows = [];
    let lastLineNumber: number|undefined;
    let lastException: string|undefined|null;
    for (const step of steps) {
        if ((step as FlowStep).skipped)
            continue;
        let lineNumber = step as number;
        let exception = null;
        if (typeof step === 'object') {
            lineNumber = step.line;
            exception = step.exception;
        }

        const important = (lastLineNumber != null && (lineNumber < lastLineNumber || lineNumber - lastLineNumber > 2)) || lastException;
        if (important) {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            jumpArrows.push({ fromLine: lastLineNumber! - 1, toLine: lineNumber - 1, options: { throw: !!lastException } });
        }
        lastLineNumber = lineNumber;
        lastException = exception;
    }
    cm.setJumpArrows(jumpArrows);

    if (steps.length === 0)
        return;

    const detailsByLine = groupToMap(steps.filter(s => typeof s === 'object') as ReadonlyArray<FlowStep>, s => s.line);
    for (const [lineNumber, details] of detailsByLine) {
        const cmLineNumber = lineNumber - 1;
        const end = cm.getLine(cmLineNumber).length;
        for (const partName of ['notes', 'exception'] as const) {
            const parts = details.map(s => s[partName]).filter(p => p) as ReadonlyArray<string>;
            if (!parts.length)
                continue;
            const widget = createFlowLineEndWidget(parts, partName);
            bookmarks.push(cm.setBookmark({ line: cmLineNumber, ch: end }, { widget }));
        }
    }
}

function createFlowLineEndWidget(contents: ReadonlyArray<string>, kind: 'notes'|'exception') {
    const widget = document.createElement('span');
    widget.className = 'flow-line-end flow-line-end-' + kind;
    widget.textContent = contents.map(escapeNewLines).join('; ');
    return widget;
}

function escapeNewLines(text: string) {
    return text
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n');
}