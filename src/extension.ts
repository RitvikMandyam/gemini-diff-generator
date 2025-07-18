import * as vscode from 'vscode';
import { GoogleGenAI } from "@google/genai";
import * as path from 'path';

const TAG = 'Gemini Diff Generator';

export function activate(context: vscode.ExtensionContext) {
	// Keep track of the last active editor and if a generation is in progress
	let lastActiveEditor: vscode.TextEditor | undefined = vscode.window.activeTextEditor;
	let isGenerationCancelled = false;

	// Update the last active editor whenever it changes
	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor(editor => {
			if (editor) {
				lastActiveEditor = editor;
			}
		})
	);

	let disposable = vscode.commands.registerCommand('gemini-diff-generator.start', () => {
		const panel = vscode.window.createWebviewPanel(
			'geminiChat',
			'Gemini Diff Generator',
			vscode.ViewColumn.Two,
			{
				enableScripts: true,
				// Retain context when webview is hidden
				retainContextWhenHidden: true,
			}
		);

		console.log(TAG, "HE:LLO! WE GO!");

		panel.webview.html = getWebviewContent();

		// Send the initial file context to the webview
		if (lastActiveEditor) {
			const fileName = lastActiveEditor.document.fileName.split(/[\\/]/).pop() || "unknown file";
			panel.webview.postMessage({ command: 'updateContext', fileName: fileName });
		}

		// Update context in the webview if the editor changes while the panel is visible
		const editorChangeSubscription = vscode.window.onDidChangeActiveTextEditor(editor => {
			if (editor && panel.visible) {
				lastActiveEditor = editor;
				const fileName = editor.document.fileName.split(/[\\/]/).pop() || "unknown file";
				panel.webview.postMessage({ command: 'updateContext', fileName: fileName });
			}
		});

		// Clean up subscription when panel is closed
		panel.onDidDispose(() => {
			editorChangeSubscription.dispose();
		});

		panel.webview.onDidReceiveMessage(
			async message => {
				console.log(TAG, message.command);
				switch (message.command) {
					case 'sendMessage': {
						// Reset cancellation flag
						isGenerationCancelled = false;

						console.log(TAG, 'editor', lastActiveEditor);
						if (!lastActiveEditor) {
							vscode.window.showErrorMessage("No active editor found to provide context.");
							panel.webview.postMessage({ command: 'generationComplete' });
							return;
						}
						console.log(TAG, 'NYOOM1');

						const document = lastActiveEditor.document;
						const fileContent = document.getText();
						const fileName = document.fileName;
						const userQuery = message.text;
						console.log(TAG, 'NYOOM2');

						const apiKey = vscode.workspace.getConfiguration('gemini-diff-generator').get('apiKey');
						if (!apiKey || typeof apiKey !== 'string' || apiKey === '') {
							vscode.window.showErrorMessage('Gemini API key not configured. Please set it in the settings.');
							panel.webview.postMessage({ command: 'generationComplete' });
							return;
						}

						console.log(TAG, 'NYOOM3');

						const genAI = new GoogleGenAI({ apiKey });
						const prompt = `
                            You are an expert programmer. Your task is to respond to the user's request.
                            The user is currently looking at this file: ${fileName}
                            ---
                            ${fileContent}
                            ---
                            The user's request is: "${userQuery}"

                            If your response involves making changes to the file content, you MUST generate the smallest possible complete diff inside a single Markdown code block with the language identifier 'diff'.
                            You MUST generate a diff that applies cleanly to the original file. Pay meticulous attention to preserving the original file's indentation and whitespace for all context lines. The diff must be in the standard unified format, with every line in each hunk starting with a '+', '-', or a space character for context. For example:
                            \`\`\`diff
                            - old line
                            + new line
                            \`\`\`
                            If you are not suggesting changes to the file, do not generate a diff.
                        `;

						console.log(TAG, 'Prompt: ', prompt);

						try {
							const request = {
								model: "gemini-2.5-pro",
								contents: prompt,
								config: {
									thinkingConfig: {
										includeThoughts: true,
									},
								},
							};

							// The user has specified to use `gemini-2.5-pro` and a specific method for enabling thinking.
							// The `generateContentStream` method takes the request object. We cast to `any` to satisfy
							// the TypeScript compiler for the user-specified `thinkingConfig` property.
							const result = await genAI.models.generateContentStream(request);

							for await (const chunk of result) {
								if (isGenerationCancelled) {
									break;
								}

								console.log(TAG, chunk);

								// Follow the user's provided logic for processing chunks with thoughts
								if (chunk.candidates && chunk.candidates[0]?.content?.parts) {
									for (const part of chunk.candidates[0].content.parts) {
										if (!part.text) { continue; }

										if (part.thought) {
											panel.webview.postMessage({ command: 'streamThought', text: part.text });
										} else {
											panel.webview.postMessage({ command: 'streamResponse', text: part.text });
										}
									}
								} else if (chunk.text) {
									// Fallback for safety, though the new model should use the structure above
									// panel.webview.postMessage({ command: 'streamResponse', text: chunk.text() });
								}
							}
						} catch (error) {
							const errorMessage = error instanceof Error ? error.message : "An unknown error occurred.";
							vscode.window.showErrorMessage(`Error communicating with Gemini API: ${errorMessage}`);
							console.error(error);
						} finally {
							// Signal that generation is complete, whether it finished, was cancelled, or errored.
							panel.webview.postMessage({
								command: 'generationComplete',
								cancelled: isGenerationCancelled
							});
						}
						return;
					}
					case 'stopGeneration': {
						isGenerationCancelled = true;
						return;
					}
					case 'applyDiff': {

						console.log(TAG, "Showing diff");

						if (!lastActiveEditor) {
							vscode.window.showErrorMessage("No active text editor to apply diff to.");
							return;
						}

						try {
							const editor = lastActiveEditor;
							const originalContent = editor.document.getText();
							const diffContent = message.diff;

							// --- Start of Manual Patch Logic ---

							interface HunkLine { type: 'add' | 'remove' | 'context'; content: string; }
							interface Hunk { lines: HunkLine[]; }

							const parseDiffToHunks = (diff: string): Hunk[] => {
								const hunks: Hunk[] = [];
								let currentHunk: Hunk | null = null;
								const diffLines = diff.split('\n');

								for (const line of diffLines) {
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
								vscode.window.showWarningMessage(`Could only apply ${successfulHunks} out of ${hunks.length} changes. Please review carefully.`);
							}

							const patchedContent = patchedLines.join('\n');
							// Create an untitled document for the right side of the diff
							const patchedDoc = await vscode.workspace.openTextDocument({
								content: patchedContent,
								language: editor.document.languageId
							});

							console.log(TAG, "Showing diff with patchedDoc: ", patchedDoc);

							const diffTitle = `Review Changes for ${path.basename(editor.document.fileName)}`;
							await vscode.commands.executeCommand('vscode.diff', editor.document.uri, patchedDoc.uri, diffTitle);

							// Prompt the user to accept or reject
							const selection = await vscode.window.showInformationMessage(
								'Review the proposed changes. You can edit the right side before accepting.',
								{ modal: true },
								'✅ Accept & Apply'
							);

							if (selection === '✅ Accept & Apply') {
								const finalContent = patchedDoc.getText();
								const fullRange = new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(editor.document.getText().length));
								await editor.edit(editBuilder => { editBuilder.replace(fullRange, finalContent); });
								await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
							}
						}
						catch (e) {
							console.error("Failed to apply patch:", e);
							vscode.window.showErrorMessage(`Failed to apply the patch. The diff format may be invalid. See debug console for details.`);
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

function getWebviewContent() {
	// All HTML, CSS, and JS is now in a single string for simplicity
	return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Gemini Chat</title>
        <script src="https://cdn.jsdelivr.net/npm/markdown-it@14.1.0/dist/markdown-it.min.js"></script>
        <style>
            body {
                font-family: var(--vscode-editor-font-family);
                font-weight: var(--vscode-editor-font-weight);
                font-size: var(--vscode-editor-font-size);
                color: var(--vscode-editor-foreground);
                background-color: var(--vscode-editor-background);
                margin: 0;
                padding: 0;
            }
            #chat-container {
                display: flex;
                flex-direction: column;
                height: 100vh;
            }
            #messages {
                flex-grow: 1;
                overflow-y: auto;
                padding: 10px;
            }
            .message {
                margin-bottom: 15px;
                padding: 10px;
                max-width: 95%;
                word-wrap: break-word;
				border-top: 2px solid var(--vscode-widget-border);
            }
			#messages .message:first-child {
                border-top: none;
            }
            .message-header {
                font-weight: bold;
                margin-bottom: 8px;
            }
            .user-message {
                background-color: var(--vscode-side-bar-background);
                align-self: flex-end;
                text-align: left;
            }
            .llm-message {
                background-color: var(--vscode-editor-background);
                align-self: flex-start;
            }
            #bottom-container {
                padding: 10px;
                border-top: 1px solid var(--vscode-widget-border);
            }
            #context-container {
                margin-bottom: 10px;
            }
            #context-container summary {
                cursor: pointer;
                opacity: 0.8;
            }
            #context-file-name {
                font-style: italic;
                opacity: 0.7;
                margin-left: 10px;
                font-size: 0.9em;
            }
            #input-area {
                display: flex;
            }
            #user-input {
                flex-grow: 1;
                background-color: var(--vscode-input-background);
                color: var(--vscode-input-foreground);
                border: 1px solid var(--vscode-input-border);
                border-radius: 3px;
                padding: 8px;
                resize: none;
            }
            button {
                margin-left: 10px;
                background-color: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                border: none;
                padding: 8px 15px;
                cursor: pointer;
                border-radius: 3px;
            }
            button:hover {
                background-color: var(--vscode-button-hover-background);
            }
            .stop-button {
                background-color: var(--vscode-button-secondary-background);
            }
            .stop-button:hover {
                background-color: var(--vscode-button-secondary-hover-background);
            }
            .thoughts-section {
                border: 1px solid var(--vscode-widget-border);
                padding: 10px;
                margin-bottom: 10px;
                border-radius: 4px;
            }
            .thoughts-section summary {
                cursor: pointer;
                font-weight: bold;
            }

           .thoughts-section > summary {
               margin-bottom: 5px; /* restore margin just for summary */           
			}
            .thoughts-content {
                background-color: var(--vscode-text-block-quote-background);
                border-left: 4px solid var(--vscode-text-block-quote-border);
                padding: 5px 10px;
                border-radius: 3px;
                margin-top: 5px;
            }
            .diff-add {
                color: var(--vscode-gitDecoration-addedResourceForeground);
            }
            .diff-del {
                color: var(--vscode-gitDecoration-deletedResourceForeground);
            }
            pre code .diff-add, pre code .diff-del {
                display: block;
            }

           .collapsible-code-wrapper {
               border: 1px solid var(--vscode-widget-border);
               border-radius: 4px;
               margin-top: 10px;
               margin-bottom: 10px;
               background-color: var(--vscode-text-block-quote-background);
           }
           .collapsible-code-wrapper pre {
               margin: 0;
               border-radius: 4px 4px 0 0;
           }
           .collapsible-code-wrapper.collapsed pre {
               max-height: 5.5em; /* Approx 3 lines */
               overflow: hidden;
           }
           .toggle-code-button {
               width: 100%;
               border-top: 1px solid var(--vscode-widget-border);
               background-color: var(--vscode-editor-background);
               border-radius: 0 0 3px 3px;
           }
           .cancelled-notice {
               color: orange;
               font-style: italic;
               margin-top: 10px;
             }
           .code-block-header {
               display: flex;
               justify-content: space-between;
               align-items: center;
               padding: 4px 8px;
               background-color: var(--vscode-editor-widget-background);
               border-bottom: 1px solid var(--vscode-widget-border);
               border-radius: 4px 4px 0 0;
           }
           .apply-button {
               margin-left: 0;
               padding: 2px 8px;
               font-size: 0.9em;
               background-color: var(--vscode-button-secondary-background);
           }						
        </style>
    </head>
    <body>
        <div id="chat-container">
            <div id="messages"></div>
            <div id="bottom-container">
                <div id="context-container">
                    <details>
                        <summary>Context Sources</summary>
                        <div id="context-file-name">Waiting for active file...</div>
                    </details>
                </div>
                <div id="input-area">
                    <textarea id="user-input" rows="3" placeholder="Enter your request... (Shift+Enter to send)"></textarea>
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
            const contextFileNameDiv = document.getElementById('context-file-name');

            let currentLlmMessageContainer = null;
            let isGenerating = false;

            // --- Event Listeners ---
            sendButton.addEventListener('click', handleSendOrStop);
            userInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && e.shiftKey) {
                    e.preventDefault();
                    if (!isGenerating) {
                        handleSendOrStop();
                    }
                }
            });

            window.addEventListener('message', event => {
                const message = event.data;
                switch (message.command) {
                    case 'updateContext':
                        contextFileNameDiv.textContent = message.fileName;
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

            // --- Logic Functions ---

            function handleSendOrStop() {
                if (isGenerating) {
                    // Handle Stop
                    vscode.postMessage({ command: 'stopGeneration' });
                    // UI will be updated by 'generationComplete' message
                } else {
                    // Handle Send
                    const text = userInput.value;
                    if (text) {
                        addMessage(text, 'user-message', 'You');
                        vscode.postMessage({ command: 'sendMessage', text: text });
                        userInput.value = '';
                        prepareForLlmResponse();
                    }
                }
            }
            
            function toggleButtonState(generating) {
                isGenerating = generating;
                if (isGenerating) {
                    sendButton.textContent = 'Stop';
                    sendButton.classList.add('stop-button');
                } else {
                    sendButton.textContent = 'Send';
                    sendButton.classList.remove('stop-button');
                }
            }

            function addMessage(text, className, headerText) {
                const messageElement = document.createElement('div');
                messageElement.className = 'message ' + className;
               messageElement.innerHTML = \`
                   <div class="message-header">\${headerText}</div>
                   <div class="message-body">\${md.render(text)}</div>\`;
                messagesDiv.appendChild(messageElement);
                messagesDiv.scrollTop = messagesDiv.scrollHeight;
            }

            function prepareForLlmResponse() {
                toggleButtonState(true);
                const llmContainer = document.createElement('div');
                llmContainer.className = 'message llm-message';
                llmContainer.innerHTML = \` 
					<div class="message-header">Gemini</div>
                    <details class="thoughts-section" open>
                        <summary>Thinking...</summary>
                        <div class="thoughts-content" style="display: none;"></div>
                    </details>
                    <div class="answer-content"></div>\`;
                messagesDiv.appendChild(llmContainer);
                currentLlmMessageContainer = llmContainer;
                messagesDiv.scrollTop = messagesDiv.scrollHeight;
            }

            function appendThought(text) {
                if (!currentLlmMessageContainer) return;
                const thoughtsContent = currentLlmMessageContainer.querySelector('.thoughts-content');
                if (thoughtsContent.style.display === 'none') {
                    thoughtsContent.style.display = 'block';
                }
                thoughtsContent.innerHTML += md.render(text);
                messagesDiv.scrollTop = messagesDiv.scrollHeight;
            }

            function appendResponse(text) {
                if (!currentLlmMessageContainer) return;
                const answerContent = currentLlmMessageContainer.querySelector('.answer-content');
                // The markdown-it library will render the text. To append streams, we add to the
                // existing text content and re-render. This isn't perfectly efficient but
                // handles complex markdown better than trying to append to innerHTML.
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
                const answerContent = currentLlmMessageContainer.querySelector('.answer-content');
                
                // Close the thoughts panel automatically
                thoughtsSection.removeAttribute('open');
                
                // If there were no thoughts, hide the entire section
                if (!thoughtsContent.hasChildNodes()) {
                    thoughtsSection.style.display = 'none';
                }

               if (cancelled) {
                   const cancelledNotice = document.createElement('div');
                   cancelledNotice.className = 'cancelled-notice';
                   cancelledNotice.textContent = 'Generation stopped.';
                   currentLlmMessageContainer.appendChild(cancelledNotice);
               }

                // Apply diff highlighting to the final rendered answer
                applyDiffHighlighting(answerContent);

                currentLlmMessageContainer = null;
                userInput.focus();
            }

            function applyDiffHighlighting(element) {
                const pres = element.querySelectorAll('pre');
                pres.forEach(pre => {
                    const code = pre.querySelector('code.language-diff');
                    if (!code) return; // Only process diff blocks
					const rawDiffText = code.textContent || '';

                    // Apply line-by-line coloring
                    const lines = code.innerHTML.split('\\n');
                    const coloredContent = lines.map(line => {
                        const escapedLine = line.replace(/</g, '&lt;').replace(/>/g, '&gt;');
                        if (escapedLine.trim().startsWith('+')) {
                            return \`<span class="diff-add">\${escapedLine}</span>\`;
                        } else if (escapedLine.trim().startsWith('-')) {
                            return \`<span class="diff-del">\${escapedLine}</span>\`;
                        }
                        return escapedLine;
                    }).join('\\n');
                    code.innerHTML = coloredContent;

                   // Wrap and add controls
                   const wrapper = document.createElement('div');
                   wrapper.className = 'collapsible-code-wrapper';

                   const header = document.createElement('div');
                   header.className = 'code-block-header';
                   header.innerHTML = \`<span>File Changes</span>\`;
                   
                   const applyButton = document.createElement('button');
                   applyButton.className = 'apply-button';
                   applyButton.textContent = 'Apply & Review';
                   header.appendChild(applyButton);				   

                   pre.parentNode.insertBefore(wrapper, pre);
				   wrapper.appendChild(header);
                   wrapper.appendChild(pre);

                   const button = document.createElement('button');
                   button.className = 'toggle-code-button';
                   wrapper.appendChild(button);

                   if (lines.length > 4) { // 3 lines + potential extra newline
                       wrapper.classList.add('collapsed');
                       button.textContent = 'Show Full Code';
                   } else {
                       button.style.display = 'none';
                   }

                   button.addEventListener('click', () => {
                       wrapper.classList.toggle('collapsed');
                       button.textContent = wrapper.classList.contains('collapsed') ? 'Show Full Code' : 'Hide Full Code';
                   });
				   
                  applyButton.addEventListener('click', () => {
                       	vscode.postMessage({ command: 'applyDiff', diff: rawDiffText });
                  });
                });
            }

        </script>
    </body>
    </html>`;
}