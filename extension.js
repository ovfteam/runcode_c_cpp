const vscode = require('vscode');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

let diagnostics;
let runningProcess;
let outputChannel;

const getConfig = () => vscode.workspace.getConfiguration('runcode');

const findGdbPath = () => {
    const possiblePaths = ['C:/ProgramData/mingw64/mingw64/bin/gdb.exe', 'C:/mingw64/bin/gdb.exe', 'C:/msys64/mingw64/bin/gdb.exe', 'gdb.exe'];

    for (const gdbPath of possiblePaths) {
        try {
            if (fs.existsSync(gdbPath)) {
                return gdbPath;
            }
        } catch {}
    }
    return 'gdb.exe';
};

const saveAllFiles = async () => {
    if (getConfig().get('autoSave', true)) {
        await vscode.workspace.saveAll();
    }
};

const activate = (context) => {
    outputChannel = vscode.window.createOutputChannel('RunCode C/C++');
    exec('gcc --version', (error) => {
        if (error) {
            vscode.window.showErrorMessage('Không tìm thấy trình biên dịch, vui lòng cài theo hướng dẫn sau.');
            vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.joinPath(context.extensionUri, 'Guide.md'));
        }
    });

    exec('g++ --version', (error) => {
        if (error) {
            vscode.window.showErrorMessage('Không tìm thấy trình biên dịch, vui lòng cài theo hướng dẫn sau.');
            vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.joinPath(context.extensionUri, 'Guide.md'));
        }
    });

    const config = vscode.workspace.getConfiguration('C_Cpp');
    if (config.get('debugShortcut') !== false) {
        config.update('debugShortcut', false, vscode.ConfigurationTarget.Global);
    }

    const stopCommand = vscode.commands.registerCommand('extension.stopCode', () => {
        if (runningProcess) {
            runningProcess.kill();
            vscode.commands.executeCommand('setContext', 'extension.buildCode.isCodeRunning', false);
            runningProcess = null;
        }
    });
    context.subscriptions.push(stopCommand);

    const disposable = vscode.commands.registerCommand('extension.buildCode', async () => {
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor) {
            const filePath = activeEditor.document.fileName;
            if (filePath.endsWith('.cpp') || filePath.endsWith('.c')) {
                vscode.commands.executeCommand('setContext', 'extension.buildCode.isCodeRunning', true);

                await saveAllFiles();

                const text = activeEditor.document.getText();
                const trimmedText = text.replace(/^[\r\n]+|[\r\n]+$/g, '');
                await activeEditor.edit((editBuilder) => {
                    const start = new vscode.Position(0, 0);
                    const end = activeEditor.document.lineAt(activeEditor.document.lineCount - 1).range.end;
                    const range = new vscode.Range(start, end);
                    editBuilder.replace(range, trimmedText);
                });
                await vscode.commands.executeCommand('editor.action.formatDocument');
                await vscode.commands.executeCommand('workbench.action.files.save');

                const outputFilePath = path.join(path.dirname(filePath), path.basename(filePath, path.extname(filePath)));
                const compilerFlags = getConfig().get('compilerFlags', '-Wall -Wextra');
                const compiler = filePath.endsWith('.cpp') ? 'g++' : 'gcc';
                const buildCommand = `${compiler} ${compilerFlags} -mconsole "${filePath}" -o "${outputFilePath}"`;

                outputChannel.clear();
                outputChannel.appendLine(`Đang build: ${buildCommand}`);

                runningProcess = exec(buildCommand, (error, stdout, stderr) => {
                    let buildSuccessful = true;

                    if (error) {
                        vscode.commands.executeCommand('setContext', 'extension.buildCode.isCodeRunning', false);
                        buildSuccessful = false;
                        vscode.window.showErrorMessage(`Lỗi: ${error.message}`);

                        const errorLineRegex = /(\d+):\d+: error: ([^]+?)(\n\s+at\s+\S+\s+\S+\s+\S+)*\n/g;
                        let match;

                        while ((match = errorLineRegex.exec(stderr)) !== null) {
                            const lineNumber = parseInt(match[1]) - 1;
                            const errorMessage = match[2];
                            const diagnostic = new vscode.Diagnostic(new vscode.Range(lineNumber, 0, lineNumber, 0), errorMessage, vscode.DiagnosticSeverity.Error);
                            diagnostics.set(vscode.window.activeTextEditor.document.uri, [diagnostic]);
                        }

                        if (buildSuccessful) {
                            diagnostics.delete(vscode.window.activeTextEditor.document.uri);
                        }
                    } else {
                        vscode.commands.executeCommand('setContext', 'extension.buildCode.isCodeRunning', false);
                        buildSuccessful = true;
                        outputChannel.appendLine('Build thành công!');
                        vscode.window.showInformationMessage('Biên dịch thành công');
                        setTimeout(() => {
                            vscode.commands.executeCommand('notifications.clearAll');
                        }, 4000);
                        if (buildSuccessful) {
                            diagnostics.delete(vscode.window.activeTextEditor.document.uri);
                        }

                        const batchContent = `@echo off
set start_time=%time%
"${outputFilePath}.exe"
set end_time=%time%
echo.
echo Nhan phim bat ki de thoat...
pause > nul
exit`;

                        const batchPath = `${outputFilePath}_run.bat`;
                        fs.writeFileSync(batchPath, batchContent);

                        const terminalCommand = `start cmd.exe /K "${batchPath}"`;
                        if (runningProcess) {
                            exec(terminalCommand, (terminalError) => {
                                if (terminalError) {
                                    outputChannel.appendLine(`Terminal error: ${terminalError.message}`);
                                }
                            });
                        }
                    }
                });
            } else {
                vscode.window.showErrorMessage('Chỉ build được code C với C++ thôi.');
            }
        } else {
            vscode.window.showErrorMessage('Vui lòng mở file code trước.');
        }
    });

    context.subscriptions.push(disposable);

    const debugCommand = vscode.commands.registerCommand('extension.debugCode', async () => {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) {
            vscode.window.showErrorMessage('Vui lòng mở file trước');
            return;
        }

        const filePath = activeEditor.document.fileName;
        if (!filePath.endsWith('.cpp') && !filePath.endsWith('.c')) {
            vscode.window.showErrorMessage('Chỉ debug được code C với C++ thôi.');
            return;
        }

        await saveAllFiles();

        const gdbPath = findGdbPath();
        if (gdbPath === 'gdb.exe') {
            exec('gdb --version', (gdbError) => {
                if (gdbError) {
                    vscode.window.showWarningMessage('GDB không tìm thấy. Debug có thể không hoạt động. Hãy cài MinGW với GDB.');
                }
            });
        }

        const outputFilePath = path.join(path.dirname(filePath), path.basename(filePath, path.extname(filePath)));
        const compiler = filePath.endsWith('.cpp') ? 'g++' : 'gcc';
        const debugBuildCommand = `${compiler} -g -O0 -mconsole "${filePath}" -o "${outputFilePath}_debug"`;

        outputChannel.clear();
        outputChannel.appendLine(`Debug Build: ${debugBuildCommand}`);

        exec(debugBuildCommand, (error, stdout, stderr) => {
            if (error) {
                vscode.window.showErrorMessage(`Debug build thất bại: ${error.message}`);
                outputChannel.appendLine(`Debug build error: ${stderr}`);
                return;
            }

            outputChannel.appendLine('Debug build thành công!');

            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (workspaceFolder) {
                const vscodePath = path.join(workspaceFolder.uri.fsPath, '.vscode');
                const launchPath = path.join(vscodePath, 'launch.json');

                const launchConfig = {
                    version: '0.2.0',
                    configurations: [
                        {
                            name: 'Debug C/C++',
                            type: 'cppdbg',
                            request: 'launch',
                            program: `${outputFilePath}_debug.exe`,
                            args: [],
                            stopAtEntry: true,
                            cwd: path.dirname(filePath),
                            environment: [],
                            externalConsole: true,
                            MIMode: 'gdb',
                            miDebuggerPath: findGdbPath(),
                            setupCommands: [
                                {
                                    description: 'Enable pretty-printing for gdb',
                                    text: '-enable-pretty-printing',
                                    ignoreFailures: true
                                },
                                {
                                    description: 'Set Disassembly Flavor to Intel',
                                    text: '-gdb-set disassembly-flavor intel',
                                    ignoreFailures: true
                                }
                            ],
                            preLaunchTask: '',
                            internalConsoleOptions: 'openOnSessionStart'
                        }
                    ]
                };

                if (!fs.existsSync(vscodePath)) {
                    fs.mkdirSync(vscodePath, { recursive: true });
                }

                fs.writeFileSync(launchPath, JSON.stringify(launchConfig, null, 4));

                setTimeout(async () => {
                    try {
                        await vscode.debug.startDebugging(workspaceFolder, 'Debug C/C++');
                        outputChannel.appendLine('Debug session started!');
                    } catch (debugError) {
                        outputChannel.appendLine(`Debug start error: ${debugError.message}`);
                        vscode.window.showErrorMessage(`Debug thất bại: ${debugError.message}`);
                    }
                }, 500);
            }
        });
    });
    context.subscriptions.push(debugCommand);

    diagnostics = vscode.languages.createDiagnosticCollection('compilation');
};

const deactivate = () => {};

module.exports = {
    activate,
    deactivate
};
