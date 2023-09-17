/*
Code flow: 
                          -> highlight.ts 
extension.ts->commands.ts -> commitView.ts/fileTree.ts
                          -> fileManager.ts
*/
import * as vscode from 'vscode';
import { CommandProcessor } from './commands';
import { execSync } from 'child_process';
import { getWorkspacePath } from './library';

let commandProcessor: CommandProcessor;

//function startProfile() {
//    console.log(process.cwd());
//    // Start profiling
//    const profile = profiler.startProfiling('myProfile', true);
//    
//    // Stop profiling after 5 seconds
//    setTimeout(() => {
//        profile.stop();
//    
//        // Export the profile data
//        profile.export((error: Error | null, result: string | null) => {
//            if (error) {
//                console.error("Error exporting profile: ", error);
//            } else {
//                fs.writeFileSync('myProfile.cpuprofile', result as string);
//            }
//            profile.delete(); // Delete the profile
//        });
//    }, 5000);
//}

function isGitRepo(command: string): boolean {
    try {
        execSync(`cd ${getWorkspacePath()} && ${command}`);// maybe cd at start
        return true;
    } catch (error) {
        return false;
    }
}

export async function activate(context: vscode.ExtensionContext) {
    //startProfile();
    const isRepo = isGitRepo("git rev-parse --is-inside-work-tree");
    console.log(`GitVision: ${isRepo}`);
    vscode.commands.executeCommand('setContext', 'GitVision.isGitRepository', isRepo);
    if (!isRepo)
        return;

    //Initialize Command Processor
    if (!commandProcessor)
        commandProcessor = await CommandProcessor.create(context);
    context.subscriptions.push(vscode.commands.registerCommand('GitVision.openSettings', () => {
        vscode.commands.executeCommand('workbench.action.openSettings', 'GitVision');
    }));
    
    //highlight current line
    commandProcessor.highlightLine(context);

    //show all commits in commit list
    commandProcessor.highlightCommits(context);

    //show all uncommited changes
    commandProcessor.highlightCurrent(context);

    //Show all changes in current branch
    commandProcessor.highlightBranch(context);

    // Add a commit to the commit list
    commandProcessor.addCommit(context);

    // Remove a commit from the commit list
    commandProcessor.removeCommit(context);

    // Hide the highlights but keep the commit list
    commandProcessor.hideHighlights(context);
    
    // Clear the highlights and commit list
    commandProcessor.clearAllHighlights(context);
    
    // Collapse the tree view
    commandProcessor.collapseAll(context);

    // Expand the tree view
    commandProcessor.expandAll(context);
    
    //Display Tree in sidebar view
    commandProcessor.updateTreeFiles(context);
}

export function deactivate() { }