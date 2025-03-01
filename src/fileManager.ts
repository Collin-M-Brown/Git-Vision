
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
import simpleGit, { SimpleGit, DefaultLogFields, LogResult } from 'simple-git';
import { GIT_REPO } from './extension';
import { InfoManager as ms } from './infoManager';
import PQueue from 'p-queue';
import { merge } from 'lodash';
import * as micromatch from 'micromatch';

const fs = require('fs');
const path = require('path');

export class FileManager {
    
    private git: SimpleGit; //simple git api used to run git commits
    //Set of promises for cached log data
    private gitLogPromise: Promise<LogResult<DefaultLogFields>>;
    private gitLsPromise: Promise<string>;
    private gitBlameLogPromise: Promise<string>;
    
    private gitLogMap: Map<string, DefaultLogFields>;
    private gitLsFiles: Set<string> = new Set();

    private gitHighlightData: { [file: string]: number[] }; //Map of file name to array of lines that should be highlighted
    private gitHighlightFiles: Set<string> = new Set(); //Stores files with changes

    private commitHashSet: Set<string> = new Set(); //Set of hashes parsed from watched commit list
    private commitList: { [key: string]: string } = {};
    private fileCounter: Map<string, number> = new Map();
    private headCommit: string = '';

    private alwaysShowUncommittedChanges: boolean;
    
    private ignorePatterns: string[] = [];

    private constructor() {
        this.git = simpleGit(GIT_REPO);
        this.gitLogPromise = this.git.log();
        this.gitLsPromise = this.git.raw(['ls-files']);
        this.gitBlameLogPromise = this.git.raw(['log','--pretty=format:%H-%P']); //log --pretty=format:%H-%P
        this.gitLogMap = new Map();
        this.gitHighlightData = {};
        this.alwaysShowUncommittedChanges = vscode.workspace.getConfiguration('GitVision').get('alwaysShowUncommittedChanges') || false;
        this.loadIgnorePatterns();

        vscode.workspace.onDidSaveTextDocument(this.handleFileSave.bind(this));
        vscode.workspace.onDidChangeConfiguration(this.handleConfigChange.bind(this));
        ms.debugLog(`alwaysShowUncommittedChanges initialized to: ${this.alwaysShowUncommittedChanges}`);
    }
    
    private loadIgnorePatterns() {
        this.ignorePatterns = vscode.workspace.getConfiguration('GitVision')
            .get<string[]>('ignorePatterns') || [];
        ms.debugLog(`Loaded ignore patterns: ${this.ignorePatterns.join(', ')}`);
    }

    private shouldIgnoreFile(filePath: string): boolean {
        const normalizedPath = filePath.replace(/\\/g, '/');
        for (const pattern of this.ignorePatterns) {
            if (micromatch.isMatch(normalizedPath, pattern)) {
                ms.debugLog(`File ${normalizedPath} matches ignore pattern ${pattern}`);
                return true;
            }
        }
        return false;
    }

    static async create() {
        const fileManager = new FileManager();
        await fileManager.setUp();
        return fileManager;
    }

    private async setUp() {
        this.headCommit = (await this.executeGitCommand(`rev-list --max-parents=0 HEAD`)).trim();
        this.gitLogMap = await this.setGitLogMap();

        this.gitLsFiles = new Set<string>((await this.gitLsPromise).split('\n'));
    }
    

    private async executeGitCommand(command: string): Promise<string> {
        try {
            const outputString = (await this.git.raw(command.split(' '))).trim();
            ms.debugLog(`running command ${command}`);
            return outputString;
        } catch (error) {
            if (error instanceof Error)
                ms.debugLog(`${error.message}`);
            return "";
        }
    }

    private async findMergedCommits() {
        const showAllCommits: boolean = vscode.workspace.getConfiguration('GitVision').get<boolean>('showAllCommits') || false;
        if (showAllCommits)
            return new Set<string>();

        const gitBlameLog = await this.gitBlameLogPromise;
        const commitsWithParents = gitBlameLog.split('\n');
        const mergeCommits = new Set<string>();
        for (const line of commitsWithParents) {
            const fields = line.split('-');
            const commitHash = fields[0];
            const parents = fields[1].split(' '); 
            if (parents.length > 1) {
                mergeCommits.add(commitHash);
            }
        }

        return mergeCommits;
    }

    private async setGitLogMap(): Promise<Map<string, DefaultLogFields>> {
        try {
            const map: Map<string, DefaultLogFields> = new Map();
            let mergesIgnored = 0;
            const mergeCommits = await this.findMergedCommits();
            
            let count = 0;
            let logEntry: DefaultLogFields;
            let addCommit = (logEntry: DefaultLogFields): void => {
                logEntry.message = `${++count}) ${logEntry.message}`;
                map.set(logEntry.message, logEntry);
                this.commitList[logEntry.message] = logEntry.date;
            };

            const current: DefaultLogFields = {
                hash: '0000000000000000000000000000000000000000',
                date: '', message: 'Uncommitted changes', author_email: '', author_name: '', refs: '', body: '',
            };
            let tempDate = new Date();
            tempDate.setFullYear(9999);
            current.date = tempDate.toDateString();
            addCommit(current);
            map.set('Uncommitted changes', current);

            let log = await this.gitLogPromise;
            for (let i = 0; i < log.all.length; i++) {
                logEntry = log.all[i];
                if (mergeCommits.has(logEntry.hash)) {
                    if (ms.TEST_MERGED_COMMITS) { //only add merged commits (for testing purposes)
                        addCommit(logEntry);
                    }
                    else
                        mergesIgnored++;
                } else if (!ms.TEST_MERGED_COMMITS){ //The usual method for adding commits.
                    addCommit(logEntry);
                }
            }
    
            ms.basicInfo(`${mergesIgnored} merge commits removed from commit repo (Disable this through settings).`);
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
                res = (await this.executeGitCommand(`diff HEAD --name-only`)).split('\n').map(s => s.trim()).filter(Boolean);
            else if (hash === this.headCommit)
                res = (await this.executeGitCommand(`diff HEAD --name-only`)).split('\n').map(s => s.trim()).filter(Boolean);
            else {
                res = (await this.executeGitCommand(`diff ${hash}~..${hash} --name-only`)).split('\n').map(s => s.trim()).filter(Boolean);
                if (vscode.workspace.getConfiguration('GitVision').get('findRenamedFiles'))
                    res = res.concat((await this.executeGitCommand(`diff ${hash}~..HEAD --find-renames=70% --name-only`)).split('\n').map(s => s.trim()).filter(Boolean));
            }

            ms.debugLog(`res for hash ${hash} = ${res}`);

            let changedFiles: string[] = [];
            for (let file of res) {
                if (this.gitLsFiles.has(file)) {
                    changedFiles.push(file);
                }
                else {
                    file = file.split("/").slice(-1)[0];
                    //TODO maybe use map to prevent repeat searches
                    //TODO: handle multiple files returned. For now, just do nothing as we can't really know if it was renamed.
                    //Also, this will cause an issue if two files have the same name but one is deleted. But should be fine as long as hash is not found.
                    const matchedFiles = Array.from(this.gitLsFiles).filter(f => f.includes(file));

                    // Handle multiple files returned
                    if (matchedFiles.length === 1) {
                        changedFiles.push(matchedFiles[0]);
                    }
                }
            }

            if (changedFiles.length === 0) {
                ms.debugLog(`Founds 0 files with changes for commit ${commit}`);
            }
            return changedFiles;
        } catch (error: unknown) {
            let message = 'Unknown error';
            if (error instanceof Error) {
                message = error.message;
            }
            vscode.window.showErrorMessage(`Error getting changed files for commit: <${commit}>`);
            return [];
        }
    }

    
    private async fillHashAndFileSet(commitList: string[]) {
        if (this.gitLogMap.size === 0) {
            vscode.window.showErrorMessage(`No git log found.`);
        }

        const filePromises = commitList.map(commit => {
            const hash = this.gitLogMap.get(commit)?.hash;
            if (hash) {
                this.commitHashSet.add(hash);
                return this.getChangedFiles(`${hash}`, commit);
            }
            return Promise.resolve([]);
        });

        const allFiles = new Set<string>((await Promise.all(filePromises)).flat());
        ms.debugLog(`${allFiles.size} potential files found before filtering.`);

        for (const file of allFiles) {
            if (!this.shouldIgnoreFile(file) && fs.existsSync(path.join(GIT_REPO, file))) {
                ms.debugLog(`File exists and not ignored: ${file}`);
                this.gitHighlightFiles.add(file);
            } else {
                ms.debugLog(`File ignored or not found: ${file}`);
            }
        }

        ms.debugLog(`${this.gitHighlightFiles.size} files with changes found after filtering.`);

        if (this.gitHighlightFiles.size > 100) {
            let confirmation = await vscode.window.showInformationMessage(
                `Detected a large number of changes: ${this.gitHighlightFiles.size} files found with changes. Are you sure you wish to process them?`,
                { modal: true },
                'Yes',
                'No'
            );

            if (!(confirmation === 'Yes')) {
                this.clearHighlightData();
            }
        }
    }

    //File should be in the form relative path
    async updateFileHighlights(file: string): Promise<number> {
        let count = 0;
        ms.debugLog(`checking ${file} for blame`);
        const includeWhitespace = vscode.workspace.getConfiguration('GitVision').get('includeWhitespaceBlame');
        try {
            let blameFile: string[];
            if (includeWhitespace)
                blameFile = (await this.executeGitCommand(`blame -l ${file}`)).split('\n');
            else
                blameFile = (await this.executeGitCommand(`blame -lw ${file}`)).split('\n');
            if (blameFile.length === 0)
                return 0;

            this.gitHighlightData[file] = [];
            for (let lineNumber = 0; lineNumber < blameFile.length; lineNumber++) {
                let lineHash = blameFile[lineNumber].split(' ')[0].trim();
                if (this.commitHashSet.has(lineHash)) { //add hash to color here
                    this.gitHighlightData[file].push(lineNumber);
                    count++;
                }
            }
        } catch (error) {
            console.error(`Error getting blame for file: ${file}`);
            ms.debugLog(`Error getting blame for file: ${file}`);
            return 0;
        }
        return count;
    }

    //The main function that gets the highlights
    /*
    reliant on...
    @this.commitHashSet
    @this.gitHighlightData
    */

    private async fillGitHighlightData(progress: any) {
        const progressIncrement = 100 / this.gitHighlightFiles.size;
        
        const queue = new PQueue({concurrency: 10});
        
        for (let file of this.gitHighlightFiles) {
            queue.add(async () => {
                ms.debugLog(`finding hash data for file: ${file}`);
                file = path.join(GIT_REPO, file);
                const count = await this.updateFileHighlights(file);
                ms.debugLog(`${count} changes found in ${file}`);
                if (count)
                    this.fileCounter.set(file, count);
                if (ms.DEBUG) {
                    ms.debugLog(`==Highlights for ${file}==`);
                    ms.debugLog(`${this.gitHighlightData[file]}`);
                    //ms.debugLog(`${this.gitHighlightData[vscode.Uri.file(path.join(GIT_REPO, file)).toString()]}`);
                    ms.debugLog(`========================`);
                }
                progress.report({ increment: progressIncrement});
            });
        }
    
        await queue.onIdle();
    }

    async addCurrentBranch(): Promise<void> {
        try {
            let branchCommits: string[] = (await this.git.raw(['log', 'main..HEAD', `--pretty=format:%s`])).split('\n').map(s => s.trim()).filter(Boolean);
            //ms.debugLog(`Commits to be added: ${branchCommits}`);
            //await this.addCommits(branchCommits); //TODOFIX
        }
        catch (error) {
            vscode.window.showErrorMessage(`Error getting branch commits`);
        }
    }

    async addCommits(watchedCommits: { [key: string]: string }, progress: any): Promise<void> {
        let temp: string[] = Object.keys(watchedCommits);
        ms.debugLog(`Adding commits: ${temp.join(', ')}`);
        ms.debugLog(`alwaysShowUncommittedChanges: ${this.alwaysShowUncommittedChanges}`);
        if (this.alwaysShowUncommittedChanges && !temp.includes('Uncommitted changes')) {
            temp.push('Uncommitted changes');
            ms.debugLog('Added Uncommitted changes to the commit list');
        }
        ms.debugLog(`Final commit list: ${temp.join(', ')}`);
        await this.fillHashAndFileSet(temp);
        await this.fillGitHighlightData(progress);
    }

    getGitHighlightData(): { [file: string]: number[] } {
        return this.gitHighlightData;
    }

    isFileWatched(file: string) {
        return file in this.gitHighlightData;
    }

    getHighlightFiles(): Map<string, number> {
        return this.fileCounter;
    }

    putHighlightFiles(newFiles: Set<string>): void {
        this.gitHighlightFiles = newFiles;
    }

    //This might cause issues in the future
    clearHighlightData() {
        this.gitHighlightData = {};
        this.gitHighlightFiles = new Set();
        this.commitHashSet = new Set();
        this.fileCounter = new Map();
    }

    saveState(context: vscode.ExtensionContext) {
        //look into this for maintaining state
        let count = context.globalState.get<number>('count');
        if (count === undefined)
            count = 0;
        context.globalState.update('count', count + 1);
    }

    getCommitList(): { [key: string]: string } {
        return this.commitList;
    }

    private siblingMessageShown: boolean = false;
    async getBrothers(commit: string) {
        const hash = this.gitLogMap.get(commit)?.hash;
        let res: { [key: string]: string } = {};
        if (hash) {
            const hashes = (await this.executeGitCommand(`log --pretty=format:%H ${hash}^1..${hash}`)).split("\n");
            for (let h of hashes) {
                //this.commitList[l.message] = l.date;
                const commitMessage = (await this.executeGitCommand(`show -s --format=%s ${h}`)).trim();
                res[commitMessage] = this.commitList[commitMessage];
            }
        }
        const numSiblings = Object.keys(res).length - 1;
        if (numSiblings > 0 && !this.siblingMessageShown) {
            ms.basicInfo(`Settings: Link merged commits enabled -- ${numSiblings} additional commits added to watch list`);
            this.siblingMessageShown = true;
        }
        return res;
    }

    private async handleConfigChange(e: vscode.ConfigurationChangeEvent) {
        if (e.affectsConfiguration('GitVision.alwaysShowUncommittedChanges')) {
            this.alwaysShowUncommittedChanges = vscode.workspace.getConfiguration('GitVision').get('alwaysShowUncommittedChanges') || false;
            if (this.alwaysShowUncommittedChanges) {
                await this.simulateUncommittedChangesSelection();
            }
        }
    }

    private async simulateUncommittedChangesSelection() {
        const uncommittedChangesCommit = {
            key: 'Uncommitted changes',
            value: new Date().toISOString()
        };
        await this.addCommits({ [uncommittedChangesCommit.key]: uncommittedChangesCommit.value }, { report: () => {} });
    }

    private async handleFileSave(document: vscode.TextDocument) {
        const filePath = document.fileName;
        const relativePath = path.relative(GIT_REPO, filePath);
        
        if (!relativePath.startsWith('..') && this.gitLsFiles.has(relativePath)) {
            const hasChanges = await this.checkFileForChanges(relativePath);
            if (hasChanges && (this.alwaysShowUncommittedChanges || this.gitHighlightFiles.has(filePath))) {
                this.gitHighlightFiles.add(filePath);
                await this.updateFileHighlights(filePath);
                this.fileCounter.set(filePath, this.gitHighlightData[filePath]?.length || 0);
                this.notifyHighlightsChanged();
            }
        }
    }

    private async checkFileForChanges(relativePath: string): Promise<boolean> {
        const output = await this.executeGitCommand(`diff --name-only ${relativePath}`);
        return output.trim() !== '';
    }

    private notifyHighlightsChanged() {
        vscode.commands.executeCommand('GitVision.refreshHighlights');
    }
}