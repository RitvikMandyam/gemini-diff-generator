import * as vscode from 'vscode';
import { GoogleGenAI } from "@google/genai";
import * as path from 'path';

const TAG = 'Gemini Diff Generator';

export function activate(context: vscode.ExtensionContext) {
	// Keep track of the last active editor and if a generation is in progress
	let lastActiveEditor: vscode.TextEditor | undefined = vscode.window.activeTextEditor;
	let isGenerationCancelled = false;

	let activeDiffUris: { original: vscode.Uri, patched: vscode.Uri } | null = null;

	// Update the last active editor whenever it changes
	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor(editor => {
			if (editor) {
				lastActiveEditor = editor;
			}

			if (activeDiffUris) {
				const visibleEditors = vscode.window.visibleTextEditors;
				const isDiffStillVisible = visibleEditors.some(e => e.document.uri === activeDiffUris?.patched);
				if (!isDiffStillVisible) {
					activeDiffUris = null;
					vscode.commands.executeCommand('setContext', 'geminiDiffGenerator.diffVisible', false);
				}
			}
		})
	);

	let acceptDiffCommand = vscode.commands.registerCommand('gemini-diff-generator.acceptDiff', async () => {
		if (!activeDiffUris) {
			vscode.window.showErrorMessage("No active Gemini diff to apply.");
			return;
		}

		try {
			// Find the two documents from our stored URIs
			const originalDoc = await vscode.workspace.openTextDocument(activeDiffUris.original);
			const patchedDoc = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === activeDiffUris!.patched.toString());

			if (!patchedDoc) {
				throw new Error("Could not find the patched document. It may have been closed.");
			}

			const finalContent = patchedDoc.getText();
			const edit = new vscode.WorkspaceEdit();
			const fullRange = new vscode.Range(
				originalDoc.positionAt(0),
				originalDoc.positionAt(originalDoc.getText().length)
			);

			// Replace original content with the final content from the diff view
			edit.replace(originalDoc.uri, fullRange, finalContent);
			await vscode.workspace.applyEdit(edit);

			// Close the diff editor tab
			await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

			vscode.window.showInformationMessage("Changes applied successfully.");

		} catch (e) {
			const errorMessage = e instanceof Error ? e.message : String(e);
			vscode.window.showErrorMessage(`Failed to apply changes: ${errorMessage}`);
		} finally {
			// Reset state
			activeDiffUris = null;
			vscode.commands.executeCommand('setContext', 'geminiDiffGenerator.diffVisible', false);
		}
	});
	context.subscriptions.push(acceptDiffCommand);

	let disposable = vscode.commands.registerCommand('gemini-diff-generator.start', () => {
		const panel = vscode.window.createWebviewPanel(
			'geminiChat',
			'Gemini Diff Generator',
			vscode.ViewColumn.Two,
			{
				enableScripts: true,
				retainContextWhenHidden: true, // Retain context when webview is hidden
			}
		);

		// Send the initial file context to the webview
		if (lastActiveEditor) {
			const relativePath = vscode.workspace.asRelativePath(lastActiveEditor.document.uri);
			panel.webview.postMessage({ command: 'updateActiveFile', filePath: relativePath });
		}

		// Update context in the webview if the editor changes while the panel is visible
		const editorChangeSubscription = vscode.window.onDidChangeActiveTextEditor(editor => {
			if (editor && panel.visible) {
				lastActiveEditor = editor;
				const relativePath = vscode.workspace.asRelativePath(editor.document.uri);
				panel.webview.postMessage({ command: 'updateActiveFile', filePath: relativePath });
			}
		});

		panel.onDidDispose(() => {
			editorChangeSubscription.dispose();
		});

		panel.webview.html = getWebviewContent();

		panel.webview.onDidReceiveMessage(
			async message => {
				switch (message.command) {
					case 'getWorkspaceFiles': {
						const query = message.query;
						if (!query) { return; }

						// Find files, excluding node_modules and .git
						const files = await vscode.workspace.findFiles(`**/*${query}*`, '**/{node_modules,.git}/**');

						const relativePaths = files.map(file =>
							vscode.workspace.asRelativePath(file)
						).slice(0, 10); // Limit to 10 suggestions for performance

						panel.webview.postMessage({ command: 'fileSuggestions', suggestions: relativePaths });
						return;
					}
					case 'sendMessage': {
						isGenerationCancelled = false;

						const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
						if (!workspaceFolder) {
							vscode.window.showErrorMessage("Please open a workspace to use this feature.");
							return;
						}

						const userQuery = message.text;
						const contextFiles = message.contextFiles as string[]; // Added files via @
						const activeFile = message.activeFile as string; // The currently viewed file

						const apiKey = vscode.workspace.getConfiguration('gemini-diff-generator').get('apiKey');
						if (!apiKey || typeof apiKey !== 'string' || apiKey === '') {
							vscode.window.showErrorMessage('Gemini API key not configured. Please set it in the settings.');
							panel.webview.postMessage({ command: 'generationComplete' });
							return;
						}

						let promptContext = '';
						const allContextFiles = Array.from(new Set([activeFile, ...contextFiles]));

						for (const relativePath of allContextFiles) {
							try {
								const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, relativePath);
								const fileContentBytes = await vscode.workspace.fs.readFile(fileUri);
								const fileContent = Buffer.from(fileContentBytes).toString('utf8');
								promptContext += `--- File: ${relativePath} ---\n${fileContent}\n--- End File: ${relativePath} ---\n\n`;
							} catch (e) {
								console.error(`Could not read file for context: ${relativePath}`, e);
								promptContext += `--- File: ${relativePath} ---\n[Could not read file content]\n--- End File: ${relativePath} ---\n\n`;
							}
						}

						const genAI = new GoogleGenAI({ apiKey });
						const prompt = `
                            You are an expert programmer. Your task is to respond to the user's request based on the provided file contexts.
                            
                            ${promptContext}
                            The user's request is: "${userQuery}"

                            If your response involves making changes to any of the provided files, you MUST generate a SEPARATE diff for EACH file you modify.
                            Each diff must be in its own Markdown code block with the language identifier 'diff'.
                            The diff header MUST include the full relative file path using the format '--- a/path/to/file.ext' and '+++ b/path/to/file.ext'.
                            Pay meticulous attention to preserving the original file's indentation and whitespace for all context lines. Each line in a hunk must start with '+', '-', or a space.
                            
                            For example:
                            \`\`\`diff
                            --- a/src/component.js
                            +++ b/src/component.js
                            @@ -1,3 +1,4 @@
                             import React from 'react';
                             
                            +console.log('hello');
                             function MyComponent() {
                            \`\`\`
                            If you are not suggesting changes to any files, do not generate a diff.
                        `;

						try {
							const request = {
								model: "gemini-2.5-pro",
								contents: prompt,
								config: { thinkingConfig: { includeThoughts: true } },
							};

							const result = await genAI.models.generateContentStream(request);

							for await (const chunk of result) {
								if (isGenerationCancelled) { break; }
								if (chunk.candidates && chunk.candidates[0]?.content?.parts) {
									for (const part of chunk.candidates[0].content.parts) {
										if (!part.text) { continue; }
										if (part.thought) {
											panel.webview.postMessage({ command: 'streamThought', text: part.text });
										} else {
											panel.webview.postMessage({ command: 'streamResponse', text: part.text });
										}
									}
								}
							}
						} catch (error) {
							const errorMessage = error instanceof Error ? error.message : "An unknown error occurred.";
							vscode.window.showErrorMessage(`Error communicating with Gemini API: ${errorMessage}`);
							console.error(error);
						} finally {
							panel.webview.postMessage({ command: 'generationComplete', cancelled: isGenerationCancelled });
						}
						return;
					}
					case 'stopGeneration': {
						isGenerationCancelled = true;
						return;
					}
					case 'applyDiff': {
						const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
						if (!workspaceFolder) {
							vscode.window.showErrorMessage("No active workspace folder found to apply diff to.");
							return;
						}

						try {
							const targetPath = message.filePath;
							const diffContent = message.diff;
							const targetUri = vscode.Uri.joinPath(workspaceFolder.uri, targetPath);

							let document;
							try {
								document = await vscode.workspace.openTextDocument(targetUri);
							} catch (e) {
								throw new Error(`File not found in workspace: ${targetPath}`);
							}

							const originalContent = document.getText();

							interface HunkLine { type: 'add' | 'remove' | 'context'; content: string; }
							interface Hunk { lines: HunkLine[]; }

							const parseDiffToHunks = (diff: string): Hunk[] => {
								const hunks: Hunk[] = [];
								let currentHunk: Hunk | null = null;
								for (const line of diff.split('\n')) {
									if (line.startsWith('@@')) {
										if (currentHunk) { hunks.push(currentHunk); }
										currentHunk = { lines: [] };
									} else if (currentHunk && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' '))) {
										const type = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'remove' : 'context';
										currentHunk.lines.push({ type, content: line.substring(1) });
									}
								}
								if (currentHunk) { hunks.push(currentHunk); }
								return hunks;
							};

							const findHunkIndex = (sourceLines: string[], hunk: Hunk): number => {
								const contextLines = hunk.lines.filter(l => l.type === 'context');
								if (contextLines.length === 0 && hunk.lines.filter(l => l.type === 'remove').length > 0) {
									const removeLines = hunk.lines.filter(l => l.type === 'remove').map(l => l.content.trim());
									for (let i = 0; i <= sourceLines.length - removeLines.length; i++) {
										const window = sourceLines.slice(i, i + removeLines.length);
										if (window.every((line, index) => line.trim() === removeLines[index])) { return i; }
									}
								}
								if (contextLines.length === 0) { return -1; }
								const searchSignature = contextLines.map(l => l.content.trim());
								for (let i = 0; i < sourceLines.length; i++) {
									if (sourceLines[i].trim() === searchSignature[0]) {
										let tempSourceIndex = i + 1;
										let tempContextIndex = 1;
										while (tempContextIndex < searchSignature.length && tempSourceIndex < sourceLines.length) {
											if (sourceLines[tempSourceIndex].trim() === searchSignature[tempContextIndex]) {
												tempContextIndex++;
											}
											tempSourceIndex++;
										}
										if (tempContextIndex === searchSignature.length) { return i; }
									}
								}
								return -1;
							};

							const firstHunkIndex = diffContent.indexOf('@@');
							if (firstHunkIndex === -1) { throw new Error("Diff does not contain any valid hunks."); }
							const cleanDiff = diffContent.substring(firstHunkIndex);

							const hunks = parseDiffToHunks(cleanDiff);
							const originalLines = originalContent.split('\n');
							const hunkStartLocations = new Map<number, Hunk>();
							let successfulHunks = 0;

							for (const hunk of hunks) {
								const index = findHunkIndex(originalLines, hunk);
								if (index !== -1) {
									hunkStartLocations.set(index, hunk);
									successfulHunks++;
								}
							}

							const patchedLines: string[] = [];
							for (let i = 0; i < originalLines.length;) {
								if (hunkStartLocations.has(i)) {
									const hunk = hunkStartLocations.get(i)!;
									hunk.lines.forEach(line => {
										if (line.type !== 'remove') { patchedLines.push(line.content); }
									});
									i += hunk.lines.filter(l => l.type !== 'add').length;
								} else {
									patchedLines.push(originalLines[i]);
									i++;
								}
							}

							if (successfulHunks < hunks.length) {
								vscode.window.showWarningMessage(`Could only apply ${successfulHunks} of ${hunks.length} changes for ${targetPath}. Please review carefully.`);
							}

							const patchedContent = patchedLines.join('\n');
							const patchedDoc = await vscode.workspace.openTextDocument({ content: patchedContent, language: document.languageId });

							activeDiffUris = { original: document.uri, patched: patchedDoc.uri };
							vscode.commands.executeCommand('setContext', 'geminiDiffGenerator.diffVisible', true);

							const diffTitle = `Review Changes for ${path.basename(targetPath)}`;
							await vscode.commands.executeCommand('vscode.diff', document.uri, patchedDoc.uri, diffTitle);

							// const selection = await vscode.window.showInformationMessage(
							// 	`Review changes for ${targetPath}. You can edit the right side before accepting.`,
							// 	{ modal: true }, '✅ Accept & Apply'
							// );

							// if (selection === '✅ Accept & Apply') {
							// 	const finalContent = patchedDoc.getText();
							// 	const edit = new vscode.WorkspaceEdit();
							// 	const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(originalContent.length));
							// 	edit.replace(document.uri, fullRange, finalContent);
							// 	await vscode.workspace.applyEdit(edit);
							// 	await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
							// }
						}
						catch (e) {
							const errorMessage = e instanceof Error ? e.message : String(e);
							console.error("Failed to apply patch:", errorMessage);
							vscode.window.showErrorMessage(`Failed to apply the patch: ${errorMessage}`);
                            activeDiffUris = null;
                            vscode.commands.executeCommand('setContext', 'geminiDiffGenerator.diffVisible', false);							
						}
						return;
					}
				}
			},
			undefined,
			context.subscriptions
		);
	});

	context.subscriptions.push(disposable);
}

function getWebviewContent(): string {
	return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Gemini Chat</title>
        <script src="https://cdn.jsdelivr.net/npm/markdown-it@14.1.0/dist/markdown-it.min.js"></script>
        <style>
            body, html {
                margin: 0;
                padding: 0;
                height: 100%;
                overflow: hidden;
                color: var(--vscode-editor-foreground);
                background-color: var(--vscode-editor-background);
                font-family: var(--vscode-font-family);
            }
            #chat-container { display: flex; flex-direction: column; height: 100vh; }
            #messages { flex-grow: 1; overflow-y: auto; padding: 10px; }
            .message {
                margin-bottom: 15px; padding: 10px; max-width: 95%;
                word-wrap: break-word; border-top: 1px solid var(--vscode-widget-border);
            }
            #messages .message:first-child { border-top: none; }
            .message-header { font-weight: bold; margin-bottom: 8px; font-size: 0.9em; opacity: 0.8; }
            .user-message { background-color: var(--vscode-side-bar-background); align-self: flex-end; }
            .llm-message { background-color: var(--vscode-editor-background); align-self: flex-start; }
            #bottom-container { padding: 10px; border-top: 1px solid var(--vscode-widget-border); flex-shrink: 0; }
            #context-container { margin-bottom: 10px; }
            #context-container summary { cursor: pointer; opacity: 0.8; }
            #context-list { font-size: 0.9em; margin-top: 5px; }
            .context-file-item { display: flex; align-items: center; margin-bottom: 3px; opacity: 0.8; }
            .context-file-item span { flex-grow: 1; }
            .remove-context-btn {
                cursor: pointer; background: none; border: none; color: var(--vscode-editor-foreground);
                font-weight: bold; margin-left: 8px; padding: 0 5px;
            }
            .remove-context-btn:hover { background-color: var(--vscode-button-secondary-background); }
            #input-area { display: flex; position: relative; }
            #user-input {
                flex-grow: 1; background-color: var(--vscode-input-background);
                color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border);
                border-radius: 3px; padding: 8px; resize: none; font-family: var(--vscode-editor-font-family);
            }
            button {
                margin-left: 10px; background-color: var(--vscode-button-background);
                color: var(--vscode-button-foreground); border: none; padding: 8px 15px;
                cursor: pointer; border-radius: 3px;
            }
            button:hover { background-color: var(--vscode-button-hover-background); }
            .stop-button { background-color: var(--vscode-button-secondary-background); }
            .stop-button:hover { background-color: var(--vscode-button-secondary-hover-background); }
            .thoughts-section { border: 1px solid var(--vscode-widget-border); padding: 10px; margin-bottom: 10px; border-radius: 4px; }
            .thoughts-section summary { cursor: pointer; font-weight: bold; margin-bottom: 5px; }
            .thoughts-content {
                background-color: var(--vscode-text-block-quote-background); border-left: 4px solid var(--vscode-text-block-quote-border);
                padding: 5px 10px; border-radius: 3px; margin-top: 5px;
            }
            .diff-add { color: var(--vscode-gitDecoration-addedResourceForeground); }
            .diff-del { color: var(--vscode-gitDecoration-deletedResourceForeground); }
            pre code .diff-add, pre code .diff-del { display: block; }
            .collapsible-code-wrapper { border: 1px solid var(--vscode-widget-border); border-radius: 4px; margin: 10px 0; background-color: var(--vscode-text-block-quote-background); }
            .collapsible-code-wrapper pre { margin: 0; }
            .collapsible-code-wrapper.collapsed pre { max-height: 5.5em; overflow: hidden; }
            .toggle-code-button { width: 100%; border-top: 1px solid var(--vscode-widget-border); background-color: var(--vscode-editor-background); border-radius: 0 0 3px 3px; }
            .cancelled-notice { color: orange; font-style: italic; margin-top: 10px; }
            .code-block-header { display: flex; justify-content: space-between; align-items: center; padding: 4px 8px; background-color: var(--vscode-editor-widget-background); border-bottom: 1px solid var(--vscode-widget-border); border-radius: 4px 4px 0 0; }
            .apply-button { margin-left: 0; padding: 2px 8px; font-size: 0.9em; background-color: var(--vscode-button-secondary-background); }
            #autocomplete-popup {
                position: absolute; bottom: 100%; left: 0; width: calc(100% - 100px); /* Adjust width */
                background-color: #0c0c0c; border: 1px solid var(--vscode-widget-border);
                border-radius: 4px; z-index: 1000; max-height: 150px; overflow-y: auto;
            }
            #autocomplete-popup div { padding: 5px 10px; cursor: pointer; }
            #autocomplete-popup div:hover { background-color: var(--vscode-list-hover-background); }
            #autocomplete-popup div.selected { background-color: var(--vscode-list-active-selection-background); }
            .hidden { display: none; }
        </style>
    </head>
    <body>
        <div id="chat-container">
            <div id="messages"></div>
            <div id="bottom-container">
                <div id="context-container">
                    <details open>
                        <summary>Context Sources</summary>
                        <div id="context-list"></div>
                    </details>
                </div>
                <div id="input-area">
                    <textarea id="user-input" rows="3" placeholder="Enter your request... (@ to add files)"></textarea>
                    <div id="autocomplete-popup" class="hidden"></div>
                    <button id="send-button">Send</button>
                </div>
            </div>
        </div>

        <script>
            const vscode = acquireVsCodeApi();
            const md = window.markdownit();
            const messagesDiv = document.getElementById('messages');
            const userInput = document.getElementById('user-input');
            const sendButton = document.getElementById('send-button');
            const contextListDiv = document.getElementById('context-list');
            const autocompletePopup = document.getElementById('autocomplete-popup');

            let currentLlmMessageContainer = null;
            let isGenerating = false;
            let activeFile = '';
            let contextFiles = new Set();
            let autocompleteState = { active: false, word: '', options: [], selectedIndex: -1 };

            function renderContextFiles() {
                contextListDiv.innerHTML = '';
                const activeItem = document.createElement('div');
                activeItem.className = 'context-file-item';
                activeItem.innerHTML = \`<span>\${activeFile} (Active)</span>\`;
                contextListDiv.appendChild(activeItem);

                contextFiles.forEach(file => {
                    const item = document.createElement('div');
                    item.className = 'context-file-item';
                    item.innerHTML = \`<span>\${file}</span><button class="remove-context-btn" data-filepath="\${file}">✖</button>\`;
                    contextListDiv.appendChild(item);
                });
            }

            contextListDiv.addEventListener('click', (e) => {
                const target = e.target;
                if (target.classList.contains('remove-context-btn')) {
                    const filePath = target.dataset.filepath;
                    if (filePath) {
                        contextFiles.delete(filePath);
                        renderContextFiles();
                    }
                }
            });

            sendButton.addEventListener('click', handleSendOrStop);
            
            userInput.addEventListener('keydown', (e) => {
                if (autocompleteState.active) {
                    if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        autocompleteState.selectedIndex = Math.min(autocompleteState.selectedIndex + 1, autocompleteState.options.length - 1);
                        updateAutocompleteSelection();
                    } else if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        autocompleteState.selectedIndex = Math.max(autocompleteState.selectedIndex - 1, 0);
                        updateAutocompleteSelection();
                    } else if (e.key === 'Tab' || e.key === 'Enter') {
                        e.preventDefault();
                        selectAutocompleteOption();
                    } else if (e.key === 'Escape' || e.key === ' ') {
                        hideAutocomplete();
                    }
                } else if (e.key === 'Enter' && e.shiftKey) {
                    e.preventDefault();
                    if (!isGenerating) handleSendOrStop();
                }
            });

            userInput.addEventListener('input', () => {
                const text = userInput.value;
                const cursorPos = userInput.selectionStart;
                const textBeforeCursor = text.substring(0, cursorPos);
                const match = textBeforeCursor.match(/(?:^|\\s)@(\\S*)$/);

                if (match) {
                    autocompleteState.active = true;
                    autocompleteState.word = match[1];
                    vscode.postMessage({ command: 'getWorkspaceFiles', query: autocompleteState.word });
                } else {
                    hideAutocomplete();
                }
            });

            function showAutocomplete(suggestions) {
                if (suggestions.length === 0) {
                    hideAutocomplete();
                    return;
                }
                autocompleteState.options = suggestions;
                autocompleteState.selectedIndex = 0;
                autocompletePopup.innerHTML = '';
                suggestions.forEach((s, index) => {
                    const item = document.createElement('div');
                    item.textContent = s;
                    if (index === 0) item.classList.add('selected');
                    item.addEventListener('click', () => {
                        autocompleteState.selectedIndex = index;
                        selectAutocompleteOption();
                    });
                    autocompletePopup.appendChild(item);
                });
                autocompletePopup.classList.remove('hidden');
            }

            function hideAutocomplete() {
                autocompleteState.active = false;
                autocompletePopup.classList.add('hidden');
            }
            
            function updateAutocompleteSelection() {
                const items = autocompletePopup.children;
                for (let i = 0; i < items.length; i++) {
                    items[i].classList.toggle('selected', i === autocompleteState.selectedIndex);
                }
            }

            function selectAutocompleteOption() {
                if (autocompleteState.selectedIndex === -1) {
                    hideAutocomplete();
                    return;
                }
                const selectedFile = autocompleteState.options[autocompleteState.selectedIndex];
                const text = userInput.value;
                const cursorPos = userInput.selectionStart;
                const textBeforeCursor = text.substring(0, cursorPos);
                const textAfterCursor = text.substring(cursorPos);
                const replacementText = selectedFile + ' ';

                const newText = textBeforeCursor.replace(/@\\S*$/, replacementText) + textAfterCursor;
                userInput.value = newText;
                
                contextFiles.add(selectedFile);
                renderContextFiles();
                hideAutocomplete();
                userInput.focus();
            }

            window.addEventListener('message', event => {
                const message = event.data;
                switch (message.command) {
                    case 'updateActiveFile':
                        activeFile = message.filePath;
                        renderContextFiles();
                        break;
                    case 'fileSuggestions':
                        if (autocompleteState.active) {
                            showAutocomplete(message.suggestions);
                        }
                        break;
                    case 'streamThought':
                        appendThought(message.text);
                        break;
                    case 'streamResponse':
                        appendResponse(message.text);
                        break;
                    case 'generationComplete':
                        finalizeGeneration(message.cancelled);
                        break;
                }
            });

            function handleSendOrStop() {
                if (isGenerating) {
                    vscode.postMessage({ command: 'stopGeneration' });
                } else {
                    const text = userInput.value;
                    if (text) {
                        addMessage(text, 'user-message', 'You');
                        vscode.postMessage({ 
                            command: 'sendMessage', 
                            text: text,
                            activeFile: activeFile,
                            contextFiles: Array.from(contextFiles) 
                        });
                        userInput.value = '';
                        prepareForLlmResponse();
                    }
                }
            }
            
            function toggleButtonState(generating) {
                isGenerating = generating;
                sendButton.textContent = generating ? 'Stop' : 'Send';
                sendButton.classList.toggle('stop-button', generating);
            }

            function addMessage(text, className, headerText) {
                const messageElement = document.createElement('div');
                messageElement.className = 'message ' + className;
                messageElement.innerHTML = \`<div class="message-header">\${headerText}</div><div class="message-body">\${md.render(text)}</div>\`;
                messagesDiv.appendChild(messageElement);
                messagesDiv.scrollTop = messagesDiv.scrollHeight;
            }

            function prepareForLlmResponse() {
                toggleButtonState(true);
                const llmContainer = document.createElement('div');
                llmContainer.className = 'message llm-message';
                llmContainer.innerHTML = \` 
                    <div class="message-header">Gemini</div>
                    <details class="thoughts-section" open><summary>Thinking...</summary><div class="thoughts-content" style="display: none;"></div></details>
                    <div class="answer-content"></div>\`;
                messagesDiv.appendChild(llmContainer);
                currentLlmMessageContainer = llmContainer;
                messagesDiv.scrollTop = messagesDiv.scrollHeight;
            }

            function appendThought(text) {
                if (!currentLlmMessageContainer) return;
                const thoughtsContent = currentLlmMessageContainer.querySelector('.thoughts-content');
                if (thoughtsContent.style.display === 'none') thoughtsContent.style.display = 'block';
                thoughtsContent.innerHTML += md.render(text); // Using render to handle markdown in thoughts
                messagesDiv.scrollTop = messagesDiv.scrollHeight;
            }

            function appendResponse(text) {
                if (!currentLlmMessageContainer) return;
                const answerContent = currentLlmMessageContainer.querySelector('.answer-content');
                const currentText = answerContent.dataset.rawText || '';
                const newText = currentText + text;
                answerContent.dataset.rawText = newText;
                answerContent.innerHTML = md.render(newText);
                messagesDiv.scrollTop = messagesDiv.scrollHeight;
            }

            function finalizeGeneration(cancelled) {
                toggleButtonState(false);
                if (!currentLlmMessageContainer) return;

                const thoughtsSection = currentLlmMessageContainer.querySelector('.thoughts-section');
                const thoughtsContent = currentLlmMessageContainer.querySelector('.thoughts-content');
                thoughtsSection.removeAttribute('open');
                if (!thoughtsContent.hasChildNodes()) thoughtsSection.style.display = 'none';

                if (cancelled) {
                   const cancelledNotice = document.createElement('div');
                   cancelledNotice.className = 'cancelled-notice';
                   cancelledNotice.textContent = 'Generation stopped.';
                   currentLlmMessageContainer.appendChild(cancelledNotice);
                }
                applyDiffHighlighting(currentLlmMessageContainer);
                currentLlmMessageContainer = null;
                userInput.focus();
            }

            function applyDiffHighlighting(element) {
                const pres = element.querySelectorAll('pre');
                pres.forEach(pre => {
                    const code = pre.querySelector('code.language-diff');
                    if (!code) return;
                    
                    const rawDiffText = code.textContent || '';
                    const pathMatch = rawDiffText.match(/---\\s+a\\/([^\\n]+)/);
                    const filePath = pathMatch ? pathMatch[1].trim() : null;

                    const lines = code.innerHTML.split('\\n');
                    const coloredContent = lines.map(line => {
                        const escapedLine = line.replace(/</g, '&lt;').replace(/>/g, '&gt;');
                        if (escapedLine.trim().startsWith('+')) return \`<span class="diff-add">\${escapedLine}</span>\`;
                        if (escapedLine.trim().startsWith('-')) return \`<span class="diff-del">\${escapedLine}</span>\`;
                        return escapedLine;
                    }).join('\\n');
                    code.innerHTML = coloredContent;

                    const wrapper = document.createElement('div');
                    wrapper.className = 'collapsible-code-wrapper';
                    const header = document.createElement('div');
                    header.className = 'code-block-header';
                    header.innerHTML = \`<span style="max-width: 80%; overflow-x: auto;">Changes for: \${filePath || 'unknown file'}</span>\`;
                    
                    if (filePath) {
                        const applyButton = document.createElement('button');
                        applyButton.className = 'apply-button';
                        applyButton.textContent = 'Apply & Review';
                        header.appendChild(applyButton);
                        applyButton.addEventListener('click', () => {
                            vscode.postMessage({ command: 'applyDiff', diff: rawDiffText, filePath: filePath });
                        });
                    }

                    pre.parentNode.insertBefore(wrapper, pre);
                    wrapper.appendChild(header);
                    wrapper.appendChild(pre);

                    const button = document.createElement('button');
                    button.className = 'toggle-code-button';
                    wrapper.appendChild(button);

                    if (lines.length > 4) {
                        wrapper.classList.add('collapsed');
                        button.textContent = 'Show Full Code';
                    } else {
                        button.style.display = 'none';
                    }
                    button.addEventListener('click', () => {
                        wrapper.classList.toggle('collapsed');
                        button.textContent = wrapper.classList.contains('collapsed') ? 'Show Full Code' : 'Hide Full Code';
                    });
                });
            }
        </script>
    </body>
    </html>`;
}