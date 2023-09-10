import * as vscode from 'vscode';
import { exit } from 'process';
import { debugLog } from './library';
import { GitProcessor } from './gitHelper';
import { FileDataProvider } from './fileTree';
import { getWorkspacePath, getCommitList } from './library';
import { HighlightProcessor } from './highlighter';
//import { fillGitHighlightData } from './gitHelper';

/*
Example format ofthis.highlights.json:
TODO: Add these files to watchlist and update when changed
{
    "file:///Users/cb/Git/Git-Changes-Highlighter/git-highlighter/src/extension.ts": [
        15,
        22,
    ],
    "file:///Users/cb/Git/Git-Changes-Highlighter/git-highlighter/src/gitHelper.ts": [
        ...,
    ]
}*/

export class CommandProcessor {
    //let jsonhighlights: string;
    private highlights: { [uri: string]: number[] };
    private gitObject!: GitProcessor;
    private hp: HighlightProcessor;
    private fileDataProvider!: FileDataProvider;

    private constructor() {
        this.highlights = {};
        this.hp = new HighlightProcessor();
        
    }

    static async create() {
        const commandProcessor = new CommandProcessor();
        commandProcessor.gitObject = await GitProcessor.create();
        vscode.window.onDidChangeVisibleTextEditors((editors: any) => {
            for (const editor of editors) {
                commandProcessor.hp.applyHighlights(editor.document);
            }
        });
        return commandProcessor;
    }

    highlightLine(context: vscode.ExtensionContext) {
        let disposable = vscode.commands.registerCommand('git-highlighter.highlightLine', () => {
            console.log("Running command: git-highlighter.highlightLine");
            this.hp.highlightLine();
        });
        console.log("highlight:line registered");
        context.subscriptions.push(disposable);
    }

    highlightCommits(context: vscode.ExtensionContext) {
        let disposable = vscode.commands.registerCommand('git-highlighter.highlightCommits', async () => {
            try {
                console.log("Running command: git-highlighter.highlightCommits");
                {
                    await this.gitObject.addCommits(getCommitList());
                    this.hp.loadHighlights(this.gitObject.getGitHighlightData());
                    console.log(`JsonHighlights set: ${this.gitObject.getGitHighlightData()}`);
                }
                const editor = vscode.window.activeTextEditor;
                if (editor) {
                    this.hp.applyHighlights(editor.document);
                }
                this.treeView(context);
            } catch (error) {
                vscode.window.showErrorMessage("diff-highlighter failed to run. Please check the console for more information.");
                exit(1);
            }
        });
        context.subscriptions.push(disposable);
    }

    highlightCurrent(context: vscode.ExtensionContext) {
        let disposable = vscode.commands.registerCommand('git-highlighter.highlightUncommitedChanges', async () => {
            try {
                    console.log("Running command: git-highlighter.highlightUncommitedChanges");
                    await this.gitObject.addCommits(["Uncommitted changes"]);
                    this.hp.loadHighlights(this.gitObject.getGitHighlightData()); 
                    for (const editor of vscode.window.visibleTextEditors) {
                        this.hp.applyHighlights(editor.document);
                    }
                    this.treeView(context);
                } catch (error) {
                    vscode.window.showErrorMessage("diff-highlighter failed to run. Please check the console for more information.");
                    exit(1);
                }
            });
        
            context.subscriptions.push(disposable);
    }

    highlightBranch(context: vscode.ExtensionContext) {
        let disposable = vscode.commands.registerCommand('git-highlighter.highlightBranch', async () => {
            try {
                console.log("Running command: git-highlighter.highlightBranch");
                await this.gitObject.addCurrentBranch();
                this.hp.loadHighlights(this.gitObject.getGitHighlightData());
                const editor = vscode.window.activeTextEditor;
                if (editor) {
                    this.hp.applyHighlights(editor.document);
                }
                this.treeView(context);
            } catch (error) {
                vscode.window.showErrorMessage("diff-highlighter failed to run. Please check the console for more information.");
                exit(1);
            }
        });
    
        context.subscriptions.push(disposable);
    }

    clearAllHighlights(context: vscode.ExtensionContext) {
        let disposable = vscode.commands.registerCommand('git-highlighter.clearAll', () => {
            console.log("Running command: git-highlighter.clearAll");
            this.gitObject.clearHighlightData();
            this.hp.clearAllHighlights();
            this.treeView(context);
        });
        context.subscriptions.push(disposable);
    }

    treeView(context: vscode.ExtensionContext) {
        //TreeView
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders !== undefined) {
            console.log(`treeView`);
            const rootPath = workspaceFolders[0].uri.fsPath;
            const fileDataProvider = new FileDataProvider(rootPath, this.gitObject.getHighlightFiles(), 2);
            vscode.window.registerTreeDataProvider('gitHighlightsView', fileDataProvider);
        }
    }

    collapseAll(context: vscode.ExtensionContext) {
        let disposable = vscode.commands.registerCommand('git-highlighter.collapseAll', () => {
            console.log("Running command: git-highlighter.collapseAll");
            if (this.fileDataProvider) {
                const workspaceFolders = vscode.workspace.workspaceFolders;
                if (workspaceFolders !== undefined) {
                    const rootPath = workspaceFolders[0].uri.fsPath;
                    this.fileDataProvider = new FileDataProvider(rootPath, this.gitObject.getHighlightFiles(), 1);
                    vscode.window.registerTreeDataProvider('gitHighlightsView', this.fileDataProvider);
                }
            }
        });

        context.subscriptions.push(disposable);
    }
}