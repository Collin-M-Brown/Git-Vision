
/*
File manager manages the state of the current repository.
It will track the git log, .ignore, file blame, and files changed, change count.
This class tends to do most of the heavy lifting and if something is slow it is probably here.

Adding a commit to the watch list:
1. Need commit message.
2. Use commit message to find commit hash.
3. Use commit hash to find files changed using git diff.

git diff notes:
git diff <hash>
    : Finds all the differences between the commit and the current state of the repository.

git diff <hash>~..<hash>
    : Finds all the differences between the hash and its parent commit
    : This one is better for my extension because it will only show files that the hash might appear in
    : There might still be empty diffs because a commits changes could have been overwritten.
git diff <hash>..HEAD
*/

import * as vscode from 'vscode';
import { execSync } from 'child_process';
import { getWorkspacePath } from './library';
import { debugLog, DEBUG } from './library';
import simpleGit, { SimpleGit, DefaultLogFields, LogResult } from 'simple-git';
import { debug } from 'console';

const fs = require('fs');
const path = require('path');

export class FileManager {
    private workspacePath: string;
    private git: SimpleGit;
    private gitLogPromise: Promise<LogResult<DefaultLogFields>>;
    private gitLogMap: Map<string, DefaultLogFields>;
    private gitLsPromise: Promise<string>;
    private gitLsFiles: Set<string> = new Set();
    private gitHighlightData: {[file: string]: number[]};
    private gitHighlightFiles: Set<string> = new Set();
    private commitHashSet: Set<string> = new Set();
    private commitList: { [key: string]: string } = {};
    private fileCounter: Map<string, number> = new Map();
    private headCommit: string = '';

    private constructor() {
        this.workspacePath = getWorkspacePath();
        this.git = simpleGit(this.workspacePath);
        this.gitLogPromise = this.git.log();
        this.gitLsPromise = this.git.raw(['ls-files']);
        this.gitLogMap = new Map();
        this.gitHighlightData = {};
    }

    static async create() {
        const fileManager = new FileManager();
        await fileManager.setUp();
        return fileManager;
    }

    private async setUp()
    {
        this.headCommit = (await this.git.raw(['rev-list', '--max-parents=0', 'HEAD'])).trim();
        this.gitLogMap = this.setgitLogMap((await this.gitLogPromise));
        this.gitLsFiles = new Set<string>((await this.gitLsPromise).split('\n'));
    }

    private executeCommand(command: string): string {
        try {
            const output = execSync(`cd ${this.workspacePath} && ${command}`);// maybe cd at start
            const outputString = output.toString();
           //debugLog(`Completed for command "${command}": ${outputString.length}`);
            return outputString;
        } catch (error) {
            console.error(`Error executing command "${command}":`); //seems to be trigged by deleted file that has blame in it...
            vscode.window.showErrorMessage(`Error executing command: ${command}`);
            return "";
        }
    }

    private async checkIgnore(filePath: string): Promise<boolean> {
        try {
            const result = await this.git.raw(['check-ignore', filePath]);
            return result.trim() !== '';
        } catch (err) {
            if (err instanceof Error) {
                if (err.message.includes('not ignored'))
                    return false;
            }
            throw err;
        }
    }

    private setgitLogMap(log: LogResult<DefaultLogFields>): Map<string, DefaultLogFields> {
        try {
            //const log = await this.git.log();
            const map: Map<string, DefaultLogFields> = new Map();
            for (let l of log.all) {
                map.set(l.message, l); //todo, maybe add multiple hashes if unsure of message.
                this.commitList[l.message] = l.date;
               //debugLog(`Commit: ${l.message}, ${l.hash}`);
            }

            const current: DefaultLogFields = {
                hash: '0000000000000000000000000000000000000000',
                date: '', message: '', author_email: '', author_name: '', refs: '', body: '', };
            map.set('Uncommitted changes', current);
            return map;
        } catch (error) {
            vscode.window.showErrorMessage(`Error getting git log`);
            return new Map();
        }
    }
    
    // Only want parse files changed to save time.
    private async getChangedFiles(hash: string, commit: string): Promise<string[]> {
        try {
            let res: string[];
            if (hash === '0000000000000000000000000000000000000000')
                res = (await this.git.raw(['diff', '--relative', `HEAD`, '--name-only'])).split('\n').map(s => s.trim()).filter(Boolean);
            else if (hash === this.headCommit)
                res = (await this.git.raw(['diff', '--relative', `HEAD`, '--name-only'])).split('\n').map(s => s.trim()).filter(Boolean);
            else
                res = (await this.git.raw(['diff', '--relative', `${hash}~..${hash}`, '--name-only'])).split('\n').map(s => s.trim()).filter(Boolean);

            if (res.length > 100)
                return [];
    
            // Filter out ignored files
            res = res.filter(file => this.gitLsFiles.has(file));
           //debugLog(`Changed files for hash: ${hash}: ${res}`);
            return res;
        } catch (error: unknown) {
            let message = 'Unknown error';
            if (error instanceof Error) {
                message = error.message;
            }
            vscode.window.showErrorMessage(`Error getting changed files for commit: <${commit}>`);
            return [];
        }
    }

    //input is a list of commit messages
    private async fillHashAndFileSet(commitList: string[]) {

        if (this.gitLogMap.size === 0) {
           //debugLog(`No git log found. Please check that you are in a git repository.`);
            vscode.window.showErrorMessage(`No git log found.`);
        }

        if (false) {
            this.gitLogMap.forEach((value, key) => {
                if (key in commitList) { debugLog(`Key: ${key}, Value: ${value.hash}`); }
            });}

        const filePromises = commitList.map(commit => {
            const hash = this.gitLogMap.get(commit)?.hash;
            if (hash) {
                this.commitHashSet.add(hash);
                console.log(`finding hash for commit: ${commit}`);
                return this.getChangedFiles(`${hash}`, commit);
            }
            return Promise.resolve([]);
        });

        const set =  new Set<string>((await Promise.all(filePromises)).flat());
        for (const file of set) { 
            //debugLog(`File: ${file}`);
            if (fs.existsSync(path.join(this.workspacePath, file))) {
                //debugLog(`File exists: ${file}`);
                this.gitHighlightFiles.add(file);
            }
            else {
                //debugLog(`File does not exist: ${file}`);
            }
        }
        //set.forEach(file => this.gitHighlightFiles.add(file));
        
        if (DEBUG) {
            debugLog(`==Files with changes==`);
            for (let file of this.gitHighlightFiles)
                debugLog(`${file}`);
            debugLog(`======================`);
        }

        //vscode.window.showInformationMessage(`Changes found in ${this.gitHighlightFiles.size} files`);
        //debugLog(`Changes found in ${this.gitHighlightFiles.size} files`);
        if (this.gitHighlightFiles.size > 100) {
            let confirmation = await vscode.window.showInformationMessage(`Detected a large number of changes: ${this.gitHighlightFiles.size} files found with changes. Are you sure you wish to process them?`, { modal: true }, 'Yes', 'No');

            if (!(confirmation === 'Yes')) {
                this.clearHighlightData();
            }
        }
    }

    //The main function that gets the highlights
    /*
    reliant on...
    @this.commitHashSet
    @this.gitHighlightData
    */
    private async fillGitHighlightData() {
        for (let file of this.gitHighlightFiles) {
            //debugLog(`finding hash data for file: ${file}`);
            file = path.join(this.workspacePath, file);
            const count = (await this.updateFileHighlights(file));
            if (count) 
                this.fileCounter.set(file, count);
            if (DEBUG) {
               debugLog(`==Highlights for ${file}==`);
               debugLog(`${this.gitHighlightData}`);
               debugLog(`${this.gitHighlightData[vscode.Uri.file(path.join(this.workspacePath, file)).toString()]}`);
               debugLog(`========================`);
            }
        }
        //debugLog(`highlights filled for ${this.fileCounter.size} files}`);
        //this.gitHighlightFiles = updatedGitHighlightFiles;
    }

    //File should be in the form relative path
    async updateFileHighlights(file: string): Promise<number> {
        //debugLog(`updating fileHighlights for file ${file}`);
        let foundInHashSet = false;
        let count = 0;
        try {
            const blameFile: string[] = (await this.git.raw(['blame', `-l`, `${file}`])).split('\n');
            if (blameFile.length === 0)
                return 0;

            this.gitHighlightData[file] = [];
            for (let lineNumber = 0; lineNumber < blameFile.length; lineNumber++) {
                let lineHash = blameFile[lineNumber].split(' ')[0].trim();
                if (this.commitHashSet.has(lineHash)) {
                    this.gitHighlightData[file].push(lineNumber);
                    foundInHashSet = true;
                    count++;
                }
            }
        } catch (error) {
            console.error(`Error getting blame for file: ${file}`);
            //vscode.window.showErrorMessage(`Error getting blame for file: ${file}`);
            return 0;
        }
        return count;
    }

    async addCurrentBranch(): Promise<void> {
        try {
            let branchCommits: string[] = (await this.git.raw(['log','main..HEAD', `--pretty=format:%s`])).split('\n').map(s => s.trim()).filter(Boolean);
            //debugLog(`Commits to be added: ${branchCommits}`);
            //await this.addCommits(branchCommits); //TODOFIX
        }
        catch (error) {
            vscode.window.showErrorMessage(`Error getting branch commits`);
        }
    }

    async addCommits(commitList: { [key: string]: string }): Promise<void> {
        let temp: string[] = Object.keys(commitList);
        // These are currently always called together so I should probably combine them
        await this.fillHashAndFileSet(temp);
        await this.fillGitHighlightData();
    }

    getGitHighlightData(): {[file: string]: number[]} {
        return this.gitHighlightData;
    }

    getHighlightFiles(): Map<string, number> {
        return this.fileCounter;
    }

    putHighlightFiles(newFiles: Set<string>): void {
        this.gitHighlightFiles = newFiles;
    }

    //This might cause issues in the future
    clearHighlightData() {
        //console.log("ALL HIGHLIGHT DATA REMOVED");
        this.gitHighlightData = {};
        this.gitHighlightFiles = new Set();
        this.commitHashSet = new Set();
        //this.commitList = {};
    }

    saveState(context: vscode.ExtensionContext) {
        //look into this for maintaining state
        let count = context.globalState.get<number>('count');
        if (count === undefined)
            count = 0;
       //debugLog(`Count is ${count}`);
        context.globalState.update('count', count + 1);
    }

    getCommitList(): { [key: string]: string }  {
        return this.commitList;
    }
}