/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * This is the place for API experiments and proposals.
 * These API are NOT stable and subject to change. They are only available in the Insiders
 * distribution and CANNOT be used in published extensions.
 *
 * To test these API in local environment:
 * - Use Insiders release of VS Code.
 * - Add `"enableProposedApi": true` to your package.json.
 * - Copy this file to your project.
 */

declare module 'vscode' {

	//#region Alex - resolvers

	export interface RemoteAuthorityResolverContext {
		resolveAttempt: number;
	}

	export class ResolvedAuthority {
		readonly host: string;
		readonly port: number;

		constructor(host: string, port: number);
	}

	export interface ResolvedOptions {
		extensionHostEnv?: { [key: string]: string | null };
	}

	export type ResolverResult = ResolvedAuthority & ResolvedOptions;

	export class RemoteAuthorityResolverError extends Error {
		static NotAvailable(message?: string, handled?: boolean): RemoteAuthorityResolverError;
		static TemporarilyNotAvailable(message?: string): RemoteAuthorityResolverError;

		constructor(message?: string);
	}

	export interface RemoteAuthorityResolver {
		resolve(authority: string, context: RemoteAuthorityResolverContext): ResolverResult | Thenable<ResolverResult>;
	}

	export interface ResourceLabelFormatter {
		scheme: string;
		authority?: string;
		formatting: ResourceLabelFormatting;
	}

	export interface ResourceLabelFormatting {
		label: string; // myLabel:/${path}
		separator: '/' | '\\' | '';
		tildify?: boolean;
		normalizeDriveLetter?: boolean;
		workspaceSuffix?: string;
		authorityPrefix?: string;
	}

	export namespace workspace {
		export function registerRemoteAuthorityResolver(authorityPrefix: string, resolver: RemoteAuthorityResolver): Disposable;
		export function registerResourceLabelFormatter(formatter: ResourceLabelFormatter): Disposable;
	}

	//#endregion

	//#region Alex - semantic tokens

	export class SemanticTokensLegend {
		public readonly tokenTypes: string[];
		public readonly tokenModifiers: string[];

		constructor(tokenTypes: string[], tokenModifiers: string[]);
	}

	export class SemanticTokensBuilder {
		constructor();
		push(line: number, char: number, length: number, tokenType: number, tokenModifiers: number): void;
		build(): Uint32Array;
	}

	export class SemanticTokens {
		readonly resultId?: string;
		readonly data: Uint32Array;

		constructor(data: Uint32Array, resultId?: string);
	}

	export class SemanticTokensEdits {
		readonly resultId?: string;
		readonly edits: SemanticTokensEdit[];

		constructor(edits: SemanticTokensEdit[], resultId?: string);
	}

	export class SemanticTokensEdit {
		readonly start: number;
		readonly deleteCount: number;
		readonly data?: Uint32Array;

		constructor(start: number, deleteCount: number, data?: Uint32Array);
	}

	export interface SemanticTokensRequestOptions {
		readonly ranges?: readonly Range[];
		readonly previousResultId?: string;
	}

	/**
	 * The semantic tokens provider interface defines the contract between extensions and
	 * semantic tokens.
	 */
	export interface SemanticTokensProvider {
		/**
		 * A file can contain many tokens, perhaps even hundreds of thousands tokens. Therefore, to improve
		 * the memory consumption around describing semantic tokens, we have decided to avoid allocating objects
		 * and we have decided to represent tokens from a file as an array of integers.
		 *
		 *
		 * In short, each token takes 5 integers to represent, so a specific token i in the file consists of the following fields:
		 *  - at index `5*i`   - `deltaLine`: token line number, relative to the previous token
		 *  - at index `5*i+1` - `deltaStart`: token start character, relative to the previous token (relative to 0 or the previous token's start if they are on the same line)
		 *  - at index `5*i+2` - `length`: the length of the token. A token cannot be multiline.
		 *  - at index `5*i+3` - `tokenType`: will be looked up in `SemanticTokensLegend.tokenTypes`
		 *  - at index `5*i+4` - `tokenModifiers`: each set bit will be looked up in `SemanticTokensLegend.tokenModifiers`
		 *
		 *
		 * Here is an example for encoding a file with 3 tokens:
		 * ```
		 *  [ { line: 2, startChar:  5, length: 3, tokenType: "properties", tokenModifiers: ["private", "static"] },
		 *    { line: 2, startChar: 10, length: 4, tokenType: "types",      tokenModifiers: [] },
		 *    { line: 5, startChar:  2, length: 7, tokenType: "classes",    tokenModifiers: [] } ]
		 * ```
		 *
		 * 1. First of all, a legend must be devised. This legend must be provided up-front and capture all possible token types.
		 * For this example, we will choose the following legend which is passed in when registering the provider:
		 * ```
		 *  { tokenTypes: ['', 'properties', 'types', 'classes'],
		 *    tokenModifiers: ['', 'private', 'static'] }
		 * ```
		 *
		 * 2. The first transformation is to encode `tokenType` and `tokenModifiers` as integers using the legend. Token types are looked
		 * up by index, so a `tokenType` value of `1` means `tokenTypes[1]`. Token modifiers are a set and they are looked up by a bitmap,
		 * so a `tokenModifier` value of `6` is first viewed as a bitmap `0b110`, so it will mean `[tokenModifiers[1], tokenModifiers[2]]` because
		 * bits 1 and 2 are set. Using this legend, the tokens now are:
		 * ```
		 *  [ { line: 2, startChar:  5, length: 3, tokenType: 1, tokenModifiers: 6 }, // 6 is 0b110
		 *    { line: 2, startChar: 10, length: 4, tokenType: 2, tokenModifiers: 0 },
		 *    { line: 5, startChar:  2, length: 7, tokenType: 3, tokenModifiers: 0 } ]
		 * ```
		 *
		 * 3. Then, we will encode each token relative to the previous token in the file:
		 * ```
		 *  [ { deltaLine: 2, deltaStartChar: 5, length: 3, tokenType: 1, tokenModifiers: 6 },
		 *    // this token is on the same line as the first one, so the startChar is made relative
		 *    { deltaLine: 0, deltaStartChar: 5, length: 4, tokenType: 2, tokenModifiers: 0 },
		 *    // this token is on a different line than the second one, so the startChar remains unchanged
		 *    { deltaLine: 3, deltaStartChar: 2, length: 7, tokenType: 3, tokenModifiers: 0 } ]
		 * ```
		 *
		 * 4. Finally, the integers are organized in a single array, which is a memory friendly representation:
		 * ```
		 *    // 1st token,  2nd token,  3rd token
		 *    [  2,5,3,1,6,  0,5,4,2,0,  3,2,7,3,0 ]
		 * ```
		 *
		 * In principle, each call to `provideSemanticTokens` expects a complete representations of the semantic tokens.
		 * It is possible to simply return all the tokens at each call.
		 *
		 * But oftentimes, a small edit in the file will result in a small change to the above delta-based represented tokens.
		 * (In fact, that is why the above tokens are delta-encoded relative to their corresponding previous tokens).
		 * In such a case, if VS Code passes in the previous result id, it is possible for an advanced tokenization provider
		 * to return a delta to the integers array.
		 *
		 * To continue with the previous example, suppose a new line has been pressed at the beginning of the file, such that
		 * all the tokens are now one line lower, and that a new token has appeared since the last result on line 4.
		 * For example, the tokens might look like:
		 * ```
		 *  [ { line: 3, startChar:  5, length: 3, tokenType: "properties", tokenModifiers: ["private", "static"] },
		 *    { line: 3, startChar: 10, length: 4, tokenType: "types",      tokenModifiers: [] },
		 *    { line: 4, startChar:  3, length: 5, tokenType: "properties", tokenModifiers: ["static"] },
		 *    { line: 6, startChar:  2, length: 7, tokenType: "classes",    tokenModifiers: [] } ]
		 * ```
		 *
		 * The integer encoding of all new tokens would be:
		 * ```
		 *     [  3,5,3,1,6,  0,5,4,2,0,  1,3,5,1,2,  2,2,7,3,0 ]
		 * ```
		 *
		 * A smart tokens provider can compute a diff from the previous result to the new result
		 * ```
		 *    [  2,5,3,1,6,  0,5,4,2,0,              3,2,7,3,0 ]
		 *    [  3,5,3,1,6,  0,5,4,2,0,  1,3,5,1,2,  2,2,7,3,0 ]
		 * ```
		 * and return as simple integer edits the diff:
		 * ```
		 * { edits: [
		 *    { start:  0, deleteCount: 1, data: [3] } // replace integer at offset 0 with 3
		 *    { start: 10, deleteCount: 1, data: [1,3,5,1,2,2] } // replace integer at offset 10 with [1,3,5,1,2,2]
		 * ]}
		 * ```
		 * All indices expressed in the returned diff represent indices in the old result array, so they all refer to the previous result state.
		 */
		provideSemanticTokens(document: TextDocument, options: SemanticTokensRequestOptions, token: CancellationToken): ProviderResult<SemanticTokens | SemanticTokensEdits>;
	}

	export namespace languages {
		/**
		 * Register a semantic tokens provider.
		 *
		 * Multiple providers can be registered for a language. In that case providers are sorted
		 * by their [score](#languages.match) and the best-matching provider is used. Failure
		 * of the selected provider will cause a failure of the whole operation.
		 *
		 * @param selector A selector that defines the documents this provider is applicable to.
		 * @param provider A semantic tokens provider.
		 * @return A [disposable](#Disposable) that unregisters this provider when being disposed.
		 */
		export function registerSemanticTokensProvider(selector: DocumentSelector, provider: SemanticTokensProvider, legend: SemanticTokensLegend): Disposable;
	}

	//#endregion

	//#region editor insets: https://github.com/microsoft/vscode/issues/85682

	export interface WebviewEditorInset {
		readonly editor: TextEditor;
		readonly line: number;
		readonly height: number;
		readonly webview: Webview;
		readonly onDidDispose: Event<void>;
		dispose(): void;
	}

	export namespace window {
		export function createWebviewTextEditorInset(editor: TextEditor, line: number, height: number, options?: WebviewOptions): WebviewEditorInset;
	}

	//#endregion

	//#region read/write in chunks: https://github.com/microsoft/vscode/issues/84515

	export interface FileSystemProvider {
		open?(resource: Uri, options: { create: boolean }): number | Thenable<number>;
		close?(fd: number): void | Thenable<void>;
		read?(fd: number, pos: number, data: Uint8Array, offset: number, length: number): number | Thenable<number>;
		write?(fd: number, pos: number, data: Uint8Array, offset: number, length: number): number | Thenable<number>;
	}

	//#endregion

	//#region TextSearchProvider: https://github.com/microsoft/vscode/issues/59921

	/**
	 * The parameters of a query for text search.
	 */
	export interface TextSearchQuery {
		/**
		 * The text pattern to search for.
		 */
		pattern: string;

		/**
		 * Whether or not `pattern` should match multiple lines of text.
		 */
		isMultiline?: boolean;

		/**
		 * Whether or not `pattern` should be interpreted as a regular expression.
		 */
		isRegExp?: boolean;

		/**
		 * Whether or not the search should be case-sensitive.
		 */
		isCaseSensitive?: boolean;

		/**
		 * Whether or not to search for whole word matches only.
		 */
		isWordMatch?: boolean;
	}

	/**
	 * A file glob pattern to match file paths against.
	 * TODO@roblou - merge this with the GlobPattern docs/definition in vscode.d.ts.
	 * @see [GlobPattern](#GlobPattern)
	 */
	export type GlobString = string;

	/**
	 * Options common to file and text search
	 */
	export interface SearchOptions {
		/**
		 * The root folder to search within.
		 */
		folder: Uri;

		/**
		 * Files that match an `includes` glob pattern should be included in the search.
		 */
		includes: GlobString[];

		/**
		 * Files that match an `excludes` glob pattern should be excluded from the search.
		 */
		excludes: GlobString[];

		/**
		 * Whether external files that exclude files, like .gitignore, should be respected.
		 * See the vscode setting `"search.useIgnoreFiles"`.
		 */
		useIgnoreFiles: boolean;

		/**
		 * Whether symlinks should be followed while searching.
		 * See the vscode setting `"search.followSymlinks"`.
		 */
		followSymlinks: boolean;

		/**
		 * Whether global files that exclude files, like .gitignore, should be respected.
		 * See the vscode setting `"search.useGlobalIgnoreFiles"`.
		 */
		useGlobalIgnoreFiles: boolean;
	}

	/**
	 * Options to specify the size of the result text preview.
	 * These options don't affect the size of the match itself, just the amount of preview text.
	 */
	export interface TextSearchPreviewOptions {
		/**
		 * The maximum number of lines in the preview.
		 * Only search providers that support multiline search will ever return more than one line in the match.
		 */
		matchLines: number;

		/**
		 * The maximum number of characters included per line.
		 */
		charsPerLine: number;
	}

	/**
	 * Options that apply to text search.
	 */
	export interface TextSearchOptions extends SearchOptions {
		/**
		 * The maximum number of results to be returned.
		 */
		maxResults: number;

		/**
		 * Options to specify the size of the result text preview.
		 */
		previewOptions?: TextSearchPreviewOptions;

		/**
		 * Exclude files larger than `maxFileSize` in bytes.
		 */
		maxFileSize?: number;

		/**
		 * Interpret files using this encoding.
		 * See the vscode setting `"files.encoding"`
		 */
		encoding?: string;

		/**
		 * Number of lines of context to include before each match.
		 */
		beforeContext?: number;

		/**
		 * Number of lines of context to include after each match.
		 */
		afterContext?: number;
	}

	/**
	 * Information collected when text search is complete.
	 */
	export interface TextSearchComplete {
		/**
		 * Whether the search hit the limit on the maximum number of search results.
		 * `maxResults` on [`TextSearchOptions`](#TextSearchOptions) specifies the max number of results.
		 * - If exactly that number of matches exist, this should be false.
		 * - If `maxResults` matches are returned and more exist, this should be true.
		 * - If search hits an internal limit which is less than `maxResults`, this should be true.
		 */
		limitHit?: boolean;
	}

	/**
	 * A preview of the text result.
	 */
	export interface TextSearchMatchPreview {
		/**
		 * The matching lines of text, or a portion of the matching line that contains the match.
		 */
		text: string;

		/**
		 * The Range within `text` corresponding to the text of the match.
		 * The number of matches must match the TextSearchMatch's range property.
		 */
		matches: Range | Range[];
	}

	/**
	 * A match from a text search
	 */
	export interface TextSearchMatch {
		/**
		 * The uri for the matching document.
		 */
		uri: Uri;

		/**
		 * The range of the match within the document, or multiple ranges for multiple matches.
		 */
		ranges: Range | Range[];

		/**
		 * A preview of the text match.
		 */
		preview: TextSearchMatchPreview;
	}

	/**
	 * A line of context surrounding a TextSearchMatch.
	 */
	export interface TextSearchContext {
		/**
		 * The uri for the matching document.
		 */
		uri: Uri;

		/**
		 * One line of text.
		 * previewOptions.charsPerLine applies to this
		 */
		text: string;

		/**
		 * The line number of this line of context.
		 */
		lineNumber: number;
	}

	export type TextSearchResult = TextSearchMatch | TextSearchContext;

	/**
	 * A TextSearchProvider provides search results for text results inside files in the workspace.
	 */
	export interface TextSearchProvider {
		/**
		 * Provide results that match the given text pattern.
		 * @param query The parameters for this query.
		 * @param options A set of options to consider while searching.
		 * @param progress A progress callback that must be invoked for all results.
		 * @param token A cancellation token.
		 */
		provideTextSearchResults(query: TextSearchQuery, options: TextSearchOptions, progress: Progress<TextSearchResult>, token: CancellationToken): ProviderResult<TextSearchComplete>;
	}

	//#endregion

	//#region FileSearchProvider: https://github.com/microsoft/vscode/issues/73524

	/**
	 * The parameters of a query for file search.
	 */
	export interface FileSearchQuery {
		/**
		 * The search pattern to match against file paths.
		 */
		pattern: string;
	}

	/**
	 * Options that apply to file search.
	 */
	export interface FileSearchOptions extends SearchOptions {
		/**
		 * The maximum number of results to be returned.
		 */
		maxResults?: number;

		/**
		 * A CancellationToken that represents the session for this search query. If the provider chooses to, this object can be used as the key for a cache,
		 * and searches with the same session object can search the same cache. When the token is cancelled, the session is complete and the cache can be cleared.
		 */
		session?: CancellationToken;
	}

	/**
	 * A FileSearchProvider provides search results for files in the given folder that match a query string. It can be invoked by quickopen or other extensions.
	 *
	 * A FileSearchProvider is the more powerful of two ways to implement file search in VS Code. Use a FileSearchProvider if you wish to search within a folder for
	 * all files that match the user's query.
	 *
	 * The FileSearchProvider will be invoked on every keypress in quickopen. When `workspace.findFiles` is called, it will be invoked with an empty query string,
	 * and in that case, every file in the folder should be returned.
	 */
	export interface FileSearchProvider {
		/**
		 * Provide the set of files that match a certain file path pattern.
		 * @param query The parameters for this query.
		 * @param options A set of options to consider while searching files.
		 * @param token A cancellation token.
		 */
		provideFileSearchResults(query: FileSearchQuery, options: FileSearchOptions, token: CancellationToken): ProviderResult<Uri[]>;
	}

	export namespace workspace {
		/**
		 * Register a search provider.
		 *
		 * Only one provider can be registered per scheme.
		 *
		 * @param scheme The provider will be invoked for workspace folders that have this file scheme.
		 * @param provider The provider.
		 * @return A [disposable](#Disposable) that unregisters this provider when being disposed.
		 */
		export function registerFileSearchProvider(scheme: string, provider: FileSearchProvider): Disposable;

		/**
		 * Register a text search provider.
		 *
		 * Only one provider can be registered per scheme.
		 *
		 * @param scheme The provider will be invoked for workspace folders that have this file scheme.
		 * @param provider The provider.
		 * @return A [disposable](#Disposable) that unregisters this provider when being disposed.
		 */
		export function registerTextSearchProvider(scheme: string, provider: TextSearchProvider): Disposable;
	}

	//#endregion

	//#region findTextInFiles: https://github.com/microsoft/vscode/issues/59924

	/**
	 * Options that can be set on a findTextInFiles search.
	 */
	export interface FindTextInFilesOptions {
		/**
		 * A [glob pattern](#GlobPattern) that defines the files to search for. The glob pattern
		 * will be matched against the file paths of files relative to their workspace. Use a [relative pattern](#RelativePattern)
		 * to restrict the search results to a [workspace folder](#WorkspaceFolder).
		 */
		include?: GlobPattern;

		/**
		 * A [glob pattern](#GlobPattern) that defines files and folders to exclude. The glob pattern
		 * will be matched against the file paths of resulting matches relative to their workspace. When `undefined` only default excludes will
		 * apply, when `null` no excludes will apply.
		 */
		exclude?: GlobPattern | null;

		/**
		 * The maximum number of results to search for
		 */
		maxResults?: number;

		/**
		 * Whether external files that exclude files, like .gitignore, should be respected.
		 * See the vscode setting `"search.useIgnoreFiles"`.
		 */
		useIgnoreFiles?: boolean;

		/**
		 * Whether global files that exclude files, like .gitignore, should be respected.
		 * See the vscode setting `"search.useGlobalIgnoreFiles"`.
		 */
		useGlobalIgnoreFiles?: boolean;

		/**
		 * Whether symlinks should be followed while searching.
		 * See the vscode setting `"search.followSymlinks"`.
		 */
		followSymlinks?: boolean;

		/**
		 * Interpret files using this encoding.
		 * See the vscode setting `"files.encoding"`
		 */
		encoding?: string;

		/**
		 * Options to specify the size of the result text preview.
		 */
		previewOptions?: TextSearchPreviewOptions;

		/**
		 * Number of lines of context to include before each match.
		 */
		beforeContext?: number;

		/**
		 * Number of lines of context to include after each match.
		 */
		afterContext?: number;
	}

	export namespace workspace {
		/**
		 * Search text in files across all [workspace folders](#workspace.workspaceFolders) in the workspace.
		 * @param query The query parameters for the search - the search string, whether it's case-sensitive, or a regex, or matches whole words.
		 * @param callback A callback, called for each result
		 * @param token A token that can be used to signal cancellation to the underlying search engine.
		 * @return A thenable that resolves when the search is complete.
		 */
		export function findTextInFiles(query: TextSearchQuery, callback: (result: TextSearchResult) => void, token?: CancellationToken): Thenable<TextSearchComplete>;

		/**
		 * Search text in files across all [workspace folders](#workspace.workspaceFolders) in the workspace.
		 * @param query The query parameters for the search - the search string, whether it's case-sensitive, or a regex, or matches whole words.
		 * @param options An optional set of query options. Include and exclude patterns, maxResults, etc.
		 * @param callback A callback, called for each result
		 * @param token A token that can be used to signal cancellation to the underlying search engine.
		 * @return A thenable that resolves when the search is complete.
		 */
		export function findTextInFiles(query: TextSearchQuery, options: FindTextInFilesOptions, callback: (result: TextSearchResult) => void, token?: CancellationToken): Thenable<TextSearchComplete>;
	}

	//#endregion

	//#region diff command: https://github.com/microsoft/vscode/issues/84899

	/**
	 * The contiguous set of modified lines in a diff.
	 */
	export interface LineChange {
		readonly originalStartLineNumber: number;
		readonly originalEndLineNumber: number;
		readonly modifiedStartLineNumber: number;
		readonly modifiedEndLineNumber: number;
	}

	export namespace commands {

		/**
		 * Registers a diff information command that can be invoked via a keyboard shortcut,
		 * a menu item, an action, or directly.
		 *
		 * Diff information commands are different from ordinary [commands](#commands.registerCommand) as
		 * they only execute when there is an active diff editor when the command is called, and the diff
		 * information has been computed. Also, the command handler of an editor command has access to
		 * the diff information.
		 *
		 * @param command A unique identifier for the command.
		 * @param callback A command handler function with access to the [diff information](#LineChange).
		 * @param thisArg The `this` context used when invoking the handler function.
		 * @return Disposable which unregisters this command on disposal.
		 */
		export function registerDiffInformationCommand(command: string, callback: (diff: LineChange[], ...args: any[]) => any, thisArg?: any): Disposable;
	}

	//#endregion

	//#region file-decorations: https://github.com/microsoft/vscode/issues/54938

	export class Decoration {
		letter?: string;
		title?: string;
		color?: ThemeColor;
		priority?: number;
		bubble?: boolean;
	}

	export interface DecorationProvider {
		onDidChangeDecorations: Event<undefined | Uri | Uri[]>;
		provideDecoration(uri: Uri, token: CancellationToken): ProviderResult<Decoration>;
	}

	export namespace window {
		export function registerDecorationProvider(provider: DecorationProvider): Disposable;
	}

	//#endregion

	//#region André: debug API for inline debug adapters https://github.com/microsoft/vscode/issues/85544

	/**
	 * A DebugProtocolMessage is an opaque stand-in type for the [ProtocolMessage](https://microsoft.github.io/debug-adapter-protocol/specification#Base_Protocol_ProtocolMessage) type defined in the Debug Adapter Protocol.
	 */
	export interface DebugProtocolMessage {
		// Properties: see details [here](https://microsoft.github.io/debug-adapter-protocol/specification#Base_Protocol_ProtocolMessage).
	}

	/**
	 * A debug adapter that implements the Debug Adapter Protocol can be registered with VS Code if it implements the DebugAdapter interface.
	 */
	export interface DebugAdapter extends Disposable {

		/**
		 * An event which fires when the debug adapter sends a Debug Adapter Protocol message to VS Code.
		 * Messages can be requests, responses, or events.
		 */
		readonly onSendMessage: Event<DebugProtocolMessage>;

		/**
		 * Handle a Debug Adapter Protocol message.
		 * Messages can be requests, responses, or events.
		 * Results or errors are returned via onSendMessage events.
		 * @param message A Debug Adapter Protocol message
		 */
		handleMessage(message: DebugProtocolMessage): void;
	}

	/**
	 * A debug adapter descriptor for an inline implementation.
	 */
	export class DebugAdapterInlineImplementation {

		/**
		 * Create a descriptor for an inline implementation of a debug adapter.
		 */
		constructor(implementation: DebugAdapter);
	}

	// deprecated

	export interface DebugConfigurationProvider {
		/**
		 * Deprecated, use DebugAdapterDescriptorFactory.provideDebugAdapter instead.
		 * @deprecated Use DebugAdapterDescriptorFactory.createDebugAdapterDescriptor instead
		 */
		debugAdapterExecutable?(folder: WorkspaceFolder | undefined, token?: CancellationToken): ProviderResult<DebugAdapterExecutable>;
	}

	//#endregion

	//#region LogLevel: https://github.com/microsoft/vscode/issues/85992

	/**
	 * The severity level of a log message
	 */
	export enum LogLevel {
		Trace = 1,
		Debug = 2,
		Info = 3,
		Warning = 4,
		Error = 5,
		Critical = 6,
		Off = 7
	}

	export namespace env {
		/**
		 * Current logging level.
		 */
		export const logLevel: LogLevel;

		/**
		 * An [event](#Event) that fires when the log level has changed.
		 */
		export const onDidChangeLogLevel: Event<LogLevel>;
	}

	//#endregion

	//#region Joao: SCM validation

	/**
	 * Represents the validation type of the Source Control input.
	 */
	export enum SourceControlInputBoxValidationType {

		/**
		 * Something not allowed by the rules of a language or other means.
		 */
		Error = 0,

		/**
		 * Something suspicious but allowed.
		 */
		Warning = 1,

		/**
		 * Something to inform about but not a problem.
		 */
		Information = 2
	}

	export interface SourceControlInputBoxValidation {

		/**
		 * The validation message to display.
		 */
		readonly message: string;

		/**
		 * The validation type.
		 */
		readonly type: SourceControlInputBoxValidationType;
	}

	/**
	 * Represents the input box in the Source Control viewlet.
	 */
	export interface SourceControlInputBox {

		/**
		 * A validation function for the input box. It's possible to change
		 * the validation provider simply by setting this property to a different function.
		 */
		validateInput?(value: string, cursorPosition: number): ProviderResult<SourceControlInputBoxValidation | undefined | null>;
	}

	//#endregion

	//#region Joao: SCM selected provider

	export interface SourceControl {

		/**
		 * Whether the source control is selected.
		 */
		readonly selected: boolean;

		/**
		 * An event signaling when the selection state changes.
		 */
		readonly onDidChangeSelection: Event<boolean>;
	}

	//#endregion

	//#region Joao: SCM Input Box

	/**
	 * Represents the input box in the Source Control viewlet.
	 */
	export interface SourceControlInputBox {

		/**
			* Controls whether the input box is visible (default is `true`).
			*/
		visible: boolean;
	}

	//#endregion

	//#region Terminal data write event https://github.com/microsoft/vscode/issues/78502

	export interface TerminalDataWriteEvent {
		/**
		 * The [terminal](#Terminal) for which the data was written.
		 */
		readonly terminal: Terminal;
		/**
		 * The data being written.
		 */
		readonly data: string;
	}

	namespace window {
		/**
		 * An event which fires when the terminal's pty slave pseudo-device is written to. In other
		 * words, this provides access to the raw data stream from the process running within the
		 * terminal, including VT sequences.
		 */
		export const onDidWriteTerminalData: Event<TerminalDataWriteEvent>;
	}

	//#endregion

	//#region Terminal exit status https://github.com/microsoft/vscode/issues/62103

	export interface TerminalExitStatus {
		/**
		 * The exit code that a terminal exited with, it can have the following values:
		 * - Zero: the terminal process or custom execution succeeded.
		 * - Non-zero: the terminal process or custom execution failed.
		 * - `undefined`: the user forcefully closed the terminal or a custom execution exited
		 *   without providing an exit code.
		 */
		readonly code: number | undefined;
	}

	export interface Terminal {
		/**
		 * The exit status of the terminal, this will be undefined while the terminal is active.
		 *
		 * **Example:** Show a notification with the exit code when the terminal exits with a
		 * non-zero exit code.
		 * ```typescript
		 * window.onDidCloseTerminal(t => {
		 *   if (t.exitStatus && t.exitStatus.code) {
		 *   	vscode.window.showInformationMessage(`Exit code: ${t.exitStatus.code}`);
		 *   }
		 * });
		 * ```
		 */
		readonly exitStatus: TerminalExitStatus | undefined;
	}

	//#endregion

	//#region Terminal creation options https://github.com/microsoft/vscode/issues/63052

	export interface Terminal {
		/**
		 * The object used to initialize the terminal, this is useful for things like detecting the
		 * shell type of shells not launched by the extension or detecting what folder the shell was
		 * launched in.
		 */
		readonly creationOptions: Readonly<TerminalOptions | ExtensionTerminalOptions>;
	}

	//#endregion

	//#region Terminal dimensions property and change event https://github.com/microsoft/vscode/issues/55718

	/**
	 * An [event](#Event) which fires when a [Terminal](#Terminal)'s dimensions change.
	 */
	export interface TerminalDimensionsChangeEvent {
		/**
		 * The [terminal](#Terminal) for which the dimensions have changed.
		 */
		readonly terminal: Terminal;
		/**
		 * The new value for the [terminal's dimensions](#Terminal.dimensions).
		 */
		readonly dimensions: TerminalDimensions;
	}

	namespace window {
		/**
		 * An event which fires when the [dimensions](#Terminal.dimensions) of the terminal change.
		 */
		export const onDidChangeTerminalDimensions: Event<TerminalDimensionsChangeEvent>;
	}

	export interface Terminal {
		/**
		 * The current dimensions of the terminal. This will be `undefined` immediately after the
		 * terminal is created as the dimensions are not known until shortly after the terminal is
		 * created.
		 */
		readonly dimensions: TerminalDimensions | undefined;
	}

	//#endregion

	//#region Joh -> exclusive document filters

	export interface DocumentFilter {
		exclusive?: boolean;
	}

	//#endregion

	//#region Alex - OnEnter enhancement
	export interface OnEnterRule {
		/**
		 * This rule will only execute if the text above the this line matches this regular expression.
		 */
		oneLineAboveText?: RegExp;
	}
	//#endregion

	//#region Tree View: https://github.com/microsoft/vscode/issues/61313
	/**
	 * Label describing the [Tree item](#TreeItem)
	 */
	export interface TreeItemLabel {

		/**
		 * A human-readable string describing the [Tree item](#TreeItem).
		 */
		label: string;

		/**
		 * Ranges in the label to highlight. A range is defined as a tuple of two number where the
		 * first is the inclusive start index and the second the exclusive end index
		 */
		highlights?: [number, number][];

	}

	export class TreeItem2 extends TreeItem {
		/**
		 * Label describing this item. When `falsy`, it is derived from [resourceUri](#TreeItem.resourceUri).
		 */
		label?: string | TreeItemLabel | /* for compilation */ any;

		/**
		 * @param label Label describing this item
		 * @param collapsibleState [TreeItemCollapsibleState](#TreeItemCollapsibleState) of the tree item. Default is [TreeItemCollapsibleState.None](#TreeItemCollapsibleState.None)
		 */
		constructor(label: TreeItemLabel, collapsibleState?: TreeItemCollapsibleState);
	}
	//#endregion

	//#region CustomExecution: https://github.com/microsoft/vscode/issues/81007
	/**
	 * A task to execute
	 */
	export class Task2 extends Task {
		detail?: string;
	}

	export class CustomExecution2 extends CustomExecution {
		/**
		 * Constructs a CustomExecution task object. The callback will be executed the task is run, at which point the
		 * extension should return the Pseudoterminal it will "run in". The task should wait to do further execution until
		 * [Pseudoterminal.open](#Pseudoterminal.open) is called. Task cancellation should be handled using
		 * [Pseudoterminal.close](#Pseudoterminal.close). When the task is complete fire
		 * [Pseudoterminal.onDidClose](#Pseudoterminal.onDidClose).
		 * @param callback The callback that will be called when the task is started by a user.
		 */
		constructor(callback: (resolvedDefinition?: TaskDefinition) => Thenable<Pseudoterminal>);
	}
	//#endregion

	//#region Task presentation group: https://github.com/microsoft/vscode/issues/47265
	export interface TaskPresentationOptions {
		/**
		 * Controls whether the task is executed in a specific terminal group using split panes.
		 */
		group?: string;
	}
	//#endregion

	//#region Ben - status bar item with ID and Name

	export namespace window {

		/**
		 * Options to configure the status bar item.
		 */
		export interface StatusBarItemOptions {

			/**
			 * A unique identifier of the status bar item. The identifier
			 * is for example used to allow a user to show or hide the
			 * status bar item in the UI.
			 */
			id: string;

			/**
			 * A human readable name of the status bar item. The name is
			 * for example used as a label in the UI to show or hide the
			 * status bar item.
			 */
			name: string;

			/**
			 * The alignment of the status bar item.
			 */
			alignment?: StatusBarAlignment;

			/**
			 * The priority of the status bar item. Higher value means the item should
			 * be shown more to the left.
			 */
			priority?: number;
		}

		/**
		 * Creates a status bar [item](#StatusBarItem).
		 *
		 * @param options The options of the item. If not provided, some default values
		 * will be assumed. For example, the `StatusBarItemOptions.id` will be the id
		 * of the extension and the `StatusBarItemOptions.name` will be the extension name.
		 * @return A new status bar item.
		 */
		export function createStatusBarItem(options?: StatusBarItemOptions): StatusBarItem;
	}

	//#endregion

	//#region Ben - extension auth flow (desktop+web)

	export interface AppUriOptions {
		payload?: {
			path?: string;
			query?: string;
			fragment?: string;
		};
	}

	export namespace env {

		/**
		 * @deprecated use `vscode.env.asExternalUri` instead.
		 */
		export function createAppUri(options?: AppUriOptions): Thenable<Uri>;
	}

	//#endregion

	//#region Custom editors: https://github.com/microsoft/vscode/issues/77131

	/**
	 * Defines how a webview editor interacts with VS Code.
	 */
	interface WebviewEditorCapabilities {
		/**
		 * Invoked when the resource has been renamed in VS Code.
		 *
		 * This is called when the resource's new name also matches the custom editor selector.
		 *
		 * If this is not implemented—or if the new resource name does not match the existing selector—then VS Code
		 * will close and reopen the editor on  rename.
		 *
		 * @param newResource Full path to the resource.
		 *
		 * @return Thenable that signals the save is complete.
		 */
		// rename?(newResource: Uri): Thenable<void>;

		/**
		 * Controls the editing functionality of a webview editor. This allows the webview editor to hook into standard
		 * editor events such as `undo` or `save`.
		 *
		 * WebviewEditors that do not have `editingCapability` are considered to be readonly. Users can still interact
		 * with readonly editors, but these editors will not integrate with VS Code's standard editor functionality.
		 */
		readonly editingCapability?: WebviewEditorEditingCapability;
	}

	/**
	 * Defines the editing functionality of a webview editor. This allows the webview editor to hook into standard
	 * editor events such as `undo` or `save`.
	 */
	interface WebviewEditorEditingCapability {
		/**
		 * Persist the resource.
		 *
		 * Extensions should persist the resource
		 *
		 * @return Thenable signaling that the save has completed.
		 */
		save(): Thenable<void>;

		/**
		 *
		 * @param resource Resource being saved.
		 * @param targetResource Location to save to.
		 */
		saveAs(resource: Uri, targetResource: Uri): Thenable<void>;

		/**
		 * Event triggered by extensions to signal to VS Code that an edit has occurred.
		 *
		 * The edit must be a json serializable object.
		 */
		readonly onEdit: Event<any>;

		/**
		 * Apply a set of edits.
		 *
		 * This is triggered on redo and when restoring a custom editor after restart. Note that is not invoked
		 * when `onEdit` is called as `onEdit` implies also updating the view to reflect the edit.
		 *
		 * @param edit Array of edits. Sorted from oldest to most recent.
		 */
		applyEdits(edits: readonly any[]): Thenable<void>;

		/**
		 * Undo a set of edits.
		 *
		 * This is triggered when a user undoes an edit or when revert is called on a file.
		 *
		 * @param edit Array of edits. Sorted from most recent to oldest.
		 */
		undoEdits(edits: readonly any[]): Thenable<void>;
	}

	export interface WebviewEditorProvider {
		/**
		 * Resolve a webview editor for a given resource.
		 *
		 * To resolve a webview editor, a provider must fill in its initial html content and hook up all
		 * the event listeners it is interested it. The provider should also take ownership of the passed in `WebviewPanel`.
		 *
		 * @param input Information about the resource being resolved.
		 * @param webview Webview being resolved. The provider should take ownership of this webview.
		 *
		 * @return Thenable to a `WebviewEditorCapabilities` indicating that the webview editor has been resolved.
		 *   The `WebviewEditorCapabilities` defines how the custom editor interacts with VS Code.
		 */
		resolveWebviewEditor(
			input: {
				readonly resource: Uri
			},
			webview: WebviewPanel,
		): Thenable<WebviewEditorCapabilities>;
	}

	namespace window {
		/**
		 * Register a new provider for webview editors of a given type.
		 *
		 * @param viewType  Type of the webview editor provider.
		 * @param provider Resolves webview editors.
		 * @param options Content settings for a webview panels the provider is given.
		 *
		 * @return Disposable that unregisters the `WebviewEditorProvider`.
		 */
		export function registerWebviewEditorProvider(
			viewType: string,
			provider: WebviewEditorProvider,
			options?: WebviewPanelOptions,
		): Disposable;
	}

	//#endregion

	//#region insert/replace completions: https://github.com/microsoft/vscode/issues/10266

	export interface CompletionItem {

		/**
		 * A range or a insert and replace range selecting the text that should be replaced by this completion item.
		 *
		 * When omitted, the range of the [current word](#TextDocument.getWordRangeAtPosition) is used as replace-range
		 * and as insert-range the start of the [current word](#TextDocument.getWordRangeAtPosition) to the
		 * current position is used.
		 *
		 * *Note 1:* A range must be a [single line](#Range.isSingleLine) and it must
		 * [contain](#Range.contains) the position at which completion has been [requested](#CompletionItemProvider.provideCompletionItems).
		 * *Note 2:* A insert range must be a prefix of a replace range, that means it must be contained and starting at the same position.
		 */
		range2?: Range | { inserting: Range; replacing: Range; };
	}

	//#endregion

	//#region allow QuickPicks to skip sorting: https://github.com/microsoft/vscode/issues/73904

	export interface QuickPick<T extends QuickPickItem> extends QuickInput {
		/**
		* An optional flag to sort the final results by index of first query match in label. Defaults to true.
		*/
		sortByLabel: boolean;
	}

	//#endregion

	//#region Surfacing reasons why a code action cannot be applied to users: https://github.com/microsoft/vscode/issues/85160

	export interface CodeAction {
		/**
		 * Marks that the code action cannot currently be applied.
		 *
		 * This should be a human readable description of why the code action is currently disabled. Disabled code actions
		 * will be surfaced in the refactor UI but cannot be applied.
		 */
		disabled?: string;
	}

	//#endregion
}
