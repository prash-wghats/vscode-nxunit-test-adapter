import { ChildProcess/*, execFile*/ } from 'child_process';
import { spawn } from 'child_process';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';

import {
	TestAdapter,
	TestLoadStartedEvent,
	TestLoadFinishedEvent,
	TestRunStartedEvent,
	TestRunFinishedEvent,
	TestSuiteEvent,
	TestEvent,
	TestSuiteInfo,
	TestInfo,
	TestDecoration
} from 'vscode-test-adapter-api';

import { Log } from 'vscode-test-adapter-util';

export class NXunitAdapter implements TestAdapter {

	private disposables: { dispose(): void }[] = [];

	private readonly testsEmitter = 
	    new vscode.EventEmitter<TestLoadStartedEvent | TestLoadFinishedEvent>();
	private readonly testStatesEmitter = new vscode.EventEmitter<TestRunStartedEvent | 
	    TestRunFinishedEvent | TestSuiteEvent | TestEvent>();
	private readonly autorunEmitter = new vscode.EventEmitter<void>();
	private SuitesInfo: TestSuiteInfo = {
		type: 'suite',
		id: 'root',
		label: 'NXunit',
		children: []
	};
	private Runningtest: ChildProcess | undefined;
	private Loadingtest: ChildProcess | undefined;
	private WSWatcher: vscode.FileSystemWatcher | undefined;
	private Nodebyid =
		new Map<string, [TestSuiteInfo | TestInfo, TestSuiteEvent | TestEvent]>();
	private FileWatcher = new Map<string, fs.FSWatcher>();

	get tests(): vscode.Event<TestLoadStartedEvent | TestLoadFinishedEvent> {
		return this.testsEmitter.event;
	}
	get testStates(): vscode.Event<TestRunStartedEvent | TestRunFinishedEvent |
		TestSuiteEvent | TestEvent> {
		return this.testStatesEmitter.event;
	}
	get autorun(): vscode.Event<void> | undefined {
		return this.autorunEmitter.event;
	}

	constructor(
		public readonly workspace: vscode.WorkspaceFolder,
		private readonly outputchannel: vscode.OutputChannel,
		private readonly log: Log
	) {
		this.Log('Initializing NXunit adapter');

		this.disposables.push(this.testsEmitter);
		this.disposables.push(this.testStatesEmitter);
		this.disposables.push(this.autorunEmitter);
		this.disposables.push(vscode.workspace.onDidChangeConfiguration(configChange => {

			this.Log('Configuration changed');

			if (configChange.affectsConfiguration('nxunitExplorer.xunit', this.workspace.uri) ||
				configChange.affectsConfiguration('nxunitExplorer.nunit', this.workspace.uri) ||
				configChange.affectsConfiguration('nxunitExplorer.modules', this.workspace.uri)) {

				this.Log('Sending reload event');
				this.load();
			}
		}));
	}


	async load(file: string = ''): Promise<void> {
		this.Log('Loading tests');

		this.testsEmitter.fire(<TestLoadStartedEvent>{ type: 'started' });

		let xexe = this.GetConfigPara("xunit");
		let nexe = this.GetConfigPara("nunit");
		
		/*
		 * The glob describing the location of your 
		 * test files (relative to the workspace folder)
		 */
		let modules = this.GetConfigPara("modules");

		if (/*(!xexe && !nexe) || */(!modules && !file)) {
			this.Log('Loading failed to start');
			this.testsEmitter.fire(<TestLoadFinishedEvent>{ type: 'finished' });
			return;
		}

		if (file == '' && modules != null) {
			await this.StopLoading();
			this.SuitesInfo.children.length = 0;
			let module = modules.split(';');
			// load test files from workspace
			var t = await this.LoadModules(module[0]);

			// load test files outside workspace
			module.splice(0, 1);
			this.SetFW(module);

			t = this.skipfiles(t);
			modules = t.join(';') + ';' + module.join(';');
		} else {
			modules = file;
			this.SuitesInfo = this.ResetSuites(this.SuitesInfo, file);
		}

		let args = this.CmdArgs('discover', modules, nexe, xexe);
		try {
			this.SuitesInfo = await this.SetTestSuiteInfo(args, this.SuitesInfo);
			if (this.SuitesInfo.children.length == 0)
				this.testsEmitter.fire(<TestLoadFinishedEvent>{ type: 'finished' });
			else
				this.testsEmitter.fire(<TestLoadFinishedEvent>{
					type: 'finished', suite: this.SuitesInfo
				});
		} catch (e) {
			this.Log(e);
			this.testsEmitter.fire(<TestLoadFinishedEvent>{ type: 'finished', 
			    suite: undefined, errorMessage: e.toString() });
		}

	}

	async run(tests: string[], mode: boolean = false): Promise<void> {
		if (this.Runningtest)
			return;
		this.Log(`Running tests ${JSON.stringify(tests)}`);

		var cmds = this.BeginTestRun(tests, mode);
		if (cmds) {
			await this.RunTest(cmds, mode);
		}
		this.EndTestRun();
	}

	async debug(tests: string[]): Promise<void> {
		this.Log('Starting the debug session');

		var cmds = this.BeginTestRun(tests, true);
		if (cmds) {
			await this.RunTest(cmds, true);
			this.EndTestRun();
		}
	}

	cancel(): void {
		//kill the child process for the current test run (if there is any)
		if (this.Runningtest) {
			this.Runningtest.kill();
			this.Runningtest = undefined;
		}
	}

	dispose(): void {
		this.cancel();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.disposables = [];
	}

	private async Debugger(cmd: string[], tests: string[]) {
		var args = cmd;
		var runner = args[0];
		args = args.splice(1);
		let breakpoint: vscode.SourceBreakpoint;
		const node = this.Nodebyid.get(tests[1]);

		if (node && (node[0].file != undefined) && node[0].line != undefined) {
			const fileURI = vscode.Uri.file(node[0].file!);
			breakpoint = new vscode.SourceBreakpoint(
				new vscode.Location(fileURI, new vscode.Position(node[0].line! + 3, 0))
			);
			vscode.debug.addBreakpoints([breakpoint]);
		}
		let debugconfig: vscode.DebugConfiguration;
		if (this.GetConfigPara("monoruntime") == "false") {
			debugconfig = {
				name: 'Debug NXunit Tests',
				type: 'clr',
				request: 'launch',
				program: runner,
				args: args,
				timeout: 30000,
				stopOnEntry: false
			};
		} else {
			let mfile:(string|null) = path.resolve(this.GetConfigPara("monopath")!);
			if (!fs.existsSync(mfile))
				mfile = null;
			debugconfig = {
				name: 'Debug NXunit Tests',
				type: 'mono',
				request: 'launch',
				runtimeExecutable: mfile,
				program: runner,
				args: args,
				timeout: 30000,
				stopOnEntry: false
			};
		}
		const debugSessionStarted = 
		    await vscode.debug.startDebugging(this.workspace, debugconfig);

		if (!debugSessionStarted) {
			this.log.error('Failed starting the debug session - aborting');
			if (this.Runningtest && this.Runningtest.stdin)
				this.Runningtest.stdin.write('Done\n');
			return;
		}

		const currentSession = vscode.debug.activeDebugSession;
		if (!currentSession) {
			this.log.error('No active debug session - aborting');
			if (this.Runningtest && this.Runningtest.stdin)
				this.Runningtest.stdin.write('Done\n');
			return;
		}

		const subscription = vscode.debug.onDidTerminateDebugSession((session) => {
			if (currentSession != session) return;
			if (breakpoint)
				vscode.debug.removeBreakpoints([breakpoint]);
			if (this.Runningtest && this.Runningtest.stdin)
				this.Runningtest.stdin.write('Done\n');
			this.Log('Debug session ended');
			subscription.dispose();
		});
	}

	//

	private GetConfigPara(para: string): string | undefined {

		let config =
			vscode.workspace.getConfiguration('nxunitExplorer', this.workspace.uri);
		switch (para) {
			case "xunit": {
				let x = config.get<string>('xunit');
				return x ? x : undefined;
			}
			case "nunit": {
				let n = config.get<string>('nunit');
				return n ? n : undefined;
			}
			case "monopath": {
				let n = config.get<string>('monopath');
				return n ? n : 'mono';
			}
			case "skippattern": {
				let n = config.get<string>('skippattern');
				return n ? n : '';
			}
			case "monoruntime": {
				let n = config.get<boolean>('monoruntime');
				return n == true ? "true" :
					(process.platform !== "win32") ? "true" : "false";
			}
			case "modules": {
				let m = config.get<string[]>('modules');
				return m ? m.join(';') : 'bin/**/*.{dll,exe}';
			}
			case "list": {
				const Dir =
					vscode.extensions.getExtension('wghats.vscode-nxunit-test-adapter');
				let list = 'bin/Release/testrun.exe';

				return list && Dir ? path.resolve(Dir.extensionPath, list) : undefined;
			}
			default: {
				return undefined;
			}
		}
	}

	private async SetTestSuiteInfo(cmdargs: string[], Suites: TestSuiteInfo) {

		return await new Promise<TestSuiteInfo>((resolve, reject) => {
			var su: TestSuiteInfo = this.MakeSuite("", "");
			var mod: TestSuiteInfo = this.MakeSuite("", "");
			let stdout = '';
			//let stderr = '';
			let exes = cmdargs[0];
			let dll = cmdargs.slice(1);
			this.Loadingtest = spawn(exes, dll, { cwd: this.workspace.uri.fsPath });
			this.Loadingtest.stdout!.on('data', data => {
				stdout += data;
			});
			this.Loadingtest.stderr!.on('data', data => {
				//stderr += data;
				this.outputchannel.append(data.toString());
			});
			this.Loadingtest.on('error', (err) => {
				//console.log(`child process exited with error ${err}`);
				Suites.children.length = 0;
				if (this.Loadingtest)
					this.Loadingtest.removeAllListeners();
				this.Loadingtest = undefined;
				reject(err);
			});
			this.Loadingtest.on('close', (code) => {
				this.Loadingtest = undefined;
				//console.log(`child process exited with code ${code}`);
				//console.log(stderr);
				this.AddtoSuite(stdout, Suites, mod, su);
				resolve(Suites);
			});
		});
	}

	private EndTestRun() {
		this.SendEvents(1);
		this.testStatesEmitter.fire(<TestRunFinishedEvent>{ type: 'finished' });
	}

	private BeginTestRun(tests: string[], mode: boolean) {

		let xexe = this.GetConfigPara("xunit");
		let nexe = this.GetConfigPara("nunit");

		this.Nodebyid.clear();
		this.testStatesEmitter.fire(<TestRunStartedEvent>{ type: 'started', tests });

		var modules: string[] = [];
		for (var id of tests) {
			for (let node of this.SuitesInfo.children) {
				let r = this.FindTest(node, this.SuitesInfo,
					this.SuitesInfo.id == id ? node.id : id);
				if (r) {
					if (node.file)
						modules.push(node.file)
				}
			}
		}

		let types: string[] = [];
		let methods: string[] = [];
		// id = [root, modulename]|[classname, methodname]
		// if run root node, no match; if run single module, modulename matches
		for (var id of tests) {
			var n = this.Nodebyid.get(id);
			if (!n || n[0].file == modules[0])
				continue;
			if (n[0].type == "suite") {
				types.push(id.split('|')[1]);
			} else
				methods.push(id.split('|')[1]);
		}

		if ((types.length > 0 || methods.length > 0) && modules.length > 1) {
			this.Log('Error: types or method run, for single modules ' 
			    + modules.join(','));
			return null;
		}

		let smode = mode ? 'debug' : 'run';
		let args = this.CmdArgs(smode, modules.join(';'), nexe, xexe,
			types.join(';'), methods.join(';'))
		this.SendEvents(0);
		return args;
	}

	private clearfrommap(mod: string[]) {
		for (let m of mod) {
			let nm = this.Nodebyid.get(m);
			if (nm == undefined)
				continue;
			if (nm[0].type == "suite") {
				nm[1].state = "completed";
				this.testStatesEmitter.fire(<TestSuiteEvent>nm[1]);
				this.Nodebyid.delete(m);
				this.Nodebyid.forEach((value, key, map) => {
					if (key.indexOf(m) != -1) {
						if (value[0].type == "suite") {
							value[1].state = "completed";
							this.testStatesEmitter.fire(<TestSuiteEvent>value[1]);
						} else {
							value[1].state = "skipped";
							this.testStatesEmitter.fire(<TestEvent>value[1]);
						}
						this.Nodebyid.delete(key);
					}
				});
			} else {
				nm[1].state = "skipped";
				this.testStatesEmitter.fire(<TestEvent>nm[1]);
				this.Nodebyid.delete(m);
			}
		}
	}

	private testslist(teststodo: string[], line: string) {
		//line = ?unit;modulename|classes?..|methods?..
		if (teststodo.length > 0) {
			this.clearfrommap(teststodo);
		}
		var tests = line.split('|');
		teststodo = tests;
		teststodo[0] = this.Winfile(teststodo[0]);

		if (tests.length > 1) {
			tests = tests.slice(1)
			for (var m of tests) {
				let nevent = this.Nodebyid.get(teststodo[0] + '|' + m);
				if (nevent) {
					if (nevent[0].type == "suite") {
						this.RecurMap(nevent[0]);
					}
				}
			}
		} else {
			var module = this.Nodebyid.get(teststodo[0]);
			if (module != undefined)
				this.RecurMap(module[0]);
		}
		return teststodo;
	}

	private ParseTestResults(result: any, teststodo: string[] = []) {

		let lines = result.split(/[\n\r]+/);

		for (const line of lines) {
			if (!line)
				continue;
			var words = line.split(";");
			//Begin a module test run
			//line = ?unit;modulename|classes?..|methods?..
			if (words.length == 2 && (words[0] == 'xunit' || words[0] == 'nunit')) {
				teststodo = this.testslist(teststodo, words[1]);
				//this.SendEvents(0);
				continue;
			}
			if (!teststodo)
				continue;
			//results: methodname|result|time|faillineno|file|fail message
			var mname = words[0];
			var state = words[1];
			var fmsg = words[5];
			var test = teststodo[0] + '|' + mname;
			let nevent = this.Nodebyid.get(test);
			if (!nevent)
				continue;
			if (state == "Failed") {
				let deco: TestDecoration[] = [];
				let lineno = Number(words[3]);
				nevent[1].state = "failed";
				if (nevent[1].type == "test") {
					let tmp: TestEvent = <TestEvent>nevent[1];
					tmp.message = fmsg;
					deco.push({ line: Number(lineno), message: fmsg });
					tmp.decorations = deco;

				}
			} else if (state == "Skipped") {
				nevent[1].state = "skipped";
			} else {
				nevent[1].state = "passed";
			}
			this.testStatesEmitter.fire(<TestEvent>nevent[1]);
			this.Nodebyid.delete(test);
		}
		return teststodo;
	}

	private SendEvents(done: number) {
		for (let nm of this.Nodebyid.values()) {
			if (nm[0].type == "suite") {
				if (done)
					nm[1].state = "completed";
				this.testStatesEmitter.fire(<TestSuiteEvent>nm[1]);
			} else {
				if (done) {
					nm[1].state = "skipped";
				}
				this.testStatesEmitter.fire(<TestEvent>nm[1]);
			}
		}
	}

	private RecurMap(node: TestSuiteInfo | TestInfo) {
		if (node.type == 'suite') {
			let ev: TestSuiteEvent = {
				type: 'suite', suite: node.id, state: 'running'
			};
			this.testStatesEmitter.fire(ev);
			this.Nodebyid.set(node.id, [node, ev]);
			for (let n of node.children)
				this.RecurMap(n);
		} else {
			let ev: TestEvent = {
				type: 'test', test: node.id, state: 'running'
			};
			this.testStatesEmitter.fire(ev);
			this.Nodebyid.set(node.id, [node, ev]);
		}
	}

	private FindTest(node: TestSuiteInfo | TestInfo,
		parent: TestSuiteInfo, id: string): boolean {
		if (node.id == id) {
			if (node.type == 'suite') {
				this.Nodebyid.set(id, [node, {
					type: 'suite', suite: node.id, state: 'running'
				}]);
				return true;
			} else {
				this.Nodebyid.set(id, [node, {
					type: 'test', test: node.id, state: 'running'
				}]);
				return true;
			}
		} else
			if (node.type == 'suite') {
				for (let n of node.children) {
					var f = this.FindTest(n, node, id);
					if (f)
						return true;
				}
			}
		return false;
	}

	private async RunTest(cmdargs: string[], debugging: boolean) {
		var teststodo: string[] = [];
		await new Promise<void>((resolve, reject) => {
			let list = cmdargs[0];
			let cmds = cmdargs.slice(1);
			this.Runningtest = spawn(list, cmds, { cwd: this.workspace.uri.fsPath });
			this.Runningtest.stdout!.on('data', data => {
				if (debugging) {
					debugging = false;
					//console.log(data.toString());
					//?unit;module|methodname;runner;..args
					let cmd = data.toString().replace('\n', '').replace('\r', '').split(';');
					let tests = cmd.splice(0, 2);
					this.Debugger(cmd, tests);
					teststodo = this.ParseTestResults(tests.join(';'), teststodo);
				} else {
					teststodo = this.ParseTestResults(data.toString(), teststodo);
				}
			});
			this.Runningtest.stderr!.on('data', data => {
				this.outputchannel.append(data.toString());
			});

			this.Runningtest.on('close', (code) => {
				//console.log(`child process exited with code ${code}`);
				this.Runningtest = undefined;
				resolve();
			});
		});
	}

	private async StopLoading() {
		if (this.Loadingtest == undefined)
			return;
		return await new Promise<void>((resolve, reject) => {
			if (this.Loadingtest != undefined) {
				this.Loadingtest.on('close', (code) => {
					resolve();
				});
				this.Loadingtest.kill();
			} else
				resolve();
		});
	}

	/* remove all tests of module fn from Suite */
	private ResetSuites(Suites: TestSuiteInfo, fn: string) {
		let i = 0;
		for (var m of Suites.children) {
			if (m.file == fn) {
				Suites.children.splice(i, 1);
				return Suites;
			}
			i++;
		}
		return Suites;
	}

	/* node id should be unique */
	AddtoSuite(stdout: string, Suites: TestSuiteInfo, mod: TestSuiteInfo,
		su: TestSuiteInfo) {
		let lines = stdout.split(/[\n\r]+/);
		var root: string = "";
		var mclass = new Map<string, TestSuiteInfo>();
		//diff tests with same name, shown as one ex=nunit.framework.tests.dll
		var mmethod = new Map<string, TestInfo>();

		for (const line of lines) {
			if (!line) {
				continue;
			}
			//line = testname;sourcefile;lineno
			var metsouno = line.split(";");
			if (metsouno.length == 2) {
				if (metsouno[0] != 'xunit' && metsouno[0] != 'nunit')
					return [mod, su];
				let fn = this.Winfile(metsouno[1]);
				//debounce
				Suites = this.ResetSuites(Suites, fn);
				mod = this.MakeSuite(fn, path.basename(metsouno[1]) + ';' 
				    + metsouno[0], fn);
				root = '';
				mclass.clear();
				mmethod.clear();
				Suites.children.push(mod);
				Suites.children.sort((a, b) => {
					if (a.id > b.id)
						return 1;
					else if (a.id < b.id)
						return -1;
					else
						return 0;
				});
				continue;
			}

			//extract class and method name. split at last (.)
			var clfun = metsouno[0].match(/(.*)\.(?![\w][^(]*\))(.*)/)
			var n: string = "";

			if (clfun && (root == "" || root != clfun[1])) { //class name
				var tmp = mclass.get(mod.file + '|' + clfun[1]);
				if (tmp) {
					su = tmp;
				} else {
					su = this.MakeSuite(mod.file + '|' + clfun[1], clfun[1]);
					mclass.set(mod.file + '|' + clfun[1], su);
					mod.children.push(su);
				}
				root = clfun[1]; //class name
			}
			if (clfun) {
				n = clfun[2];
			} else
				n = metsouno[0];

			if (metsouno[1] && metsouno[2])
				var ch = this.MakeTest(mod.file + '|' + metsouno[0], n,
					this.Winfile(metsouno[1]), Number(metsouno[2]) - 2);
			else
				var ch = this.MakeTest(mod.file + '|' + metsouno[0], n);
			//skip tests with same name
			if (!mmethod.get(mod.file + '|' + metsouno[0])) {
				mmethod.set(mod.file + '|' + metsouno[0], ch);
				if (clfun) {
					su.children.push(ch);
				} else
					mod.children.push(ch);

			}
		}
		return [mod, su];
	}

	//in windows;if root drive letter is caps, gutter decorations does not work?
	private Winfile(f: string) {
		if (process.platform === "win32") {
			f = f.charAt(0).toLowerCase() + f.slice(1);
		}
		return path.resolve(f);
	}

	private MakeSuite(suite_id: string, suite_name: string,
		suite_file?: string): TestSuiteInfo {
		return {
			type: 'suite',
			id: suite_id,
			label: suite_name,
			file: suite_file ? path.resolve(suite_file) : undefined,
			children: []
		};
	}

	private MakeTest(test_id: string, name: string, file?: string,
		lineno?: number): TestInfo {
		return {
			type: 'test',
			id: test_id,
			label: name,
			file: file ? path.resolve(file) : undefined,
			line: lineno,
			skipped: false
		};
	}

	private Log(msg: string) {
		if (this.log.enabled)
			this.log.info(msg);
	}

	private CmdArgs(mode: string, target: string, nexe?: string, xexe?: string,
		types?: string, methods?: string) {
		let monop = '';
		let args: string[] = [];
		const mono = this.GetConfigPara("monoruntime");
		if (mono == "true") {
			monop = this.GetConfigPara("monopath")!;
			args.push(monop!);
			args.push('--debug')
		}

		const list = this.GetConfigPara("list");
		if (!list)
			return args;
		args.push(list);
		if (mono == "true") {
			args.push('-m'); args.push(monop);
		}
		if (xexe) {
			args.push('-x'); args.push(xexe);
		}
		if (nexe) {
			args.push('-n'); args.push(nexe);
		}
		args.push(mode);
		{
			var filename = 'nxunit_'+crypto.randomBytes(4).readUInt32LE(0);
			const temp = path.join(os.tmpdir(), filename);
			fs.writeFileSync(temp, target);
			args.push('-f'); args.push(temp);
		}
		{
			//args.push('-t'); args.push(target);
		}
		if (types) {
			args.push('-ac'); args.push(types);
		}
		if (methods) {
			args.push('-am'); args.push(methods);
		}
		this.Log(mode + ' mode cmd: ' + args.join(' '));
		return args;
	}

	private async LoadModules(module: string) {
		// global pattern for createFileSystemWatcher
		const globr = path.resolve(this.workspace.uri.fsPath, module!);
		// relative pattern for findFiles
		const glob = new vscode.RelativePattern(this.workspace.uri.fsPath, module!);
		let modules: string[] = [];
		for (const file of await vscode.workspace.findFiles(glob)) {
			modules.push(file.fsPath);
		}
		if (this.WSWatcher != undefined)
			this.WSWatcher.dispose();
		this.WSWatcher = vscode.workspace.createFileSystemWatcher(globr);
		this.addwatcher(this.WSWatcher);
		return modules;
	}

	private addwatcher(watcher: vscode.FileSystemWatcher) {
		watcher.onDidChange((file) => {
			//this.Log('Module changed ' + file.fsPath);
			//this.load(file.fsPath);
			this.filechange(file.fsPath, '');
		});
		watcher.onDidCreate((file) => {
			this.filechange(file.fsPath, '');
		});
		watcher.onDidDelete((file) => {
			this.filechange(file.fsPath, '');
		});
		return watcher;
	}

	private filechange(fn: string, jname: string) {
		var ext = fn.substr(fn.lastIndexOf('.') + 1);
		if (ext != 'dll' && ext != 'exe')
			return;

		let f = this.Winfile(path.join(jname, fn));
		if (this.Loadingtest == undefined && this.Runningtest == undefined) {
			this.Log('file Changed ' + f);
			this.load(f);
		}
	}

	private SetFW(m: string[]) {
		for (var fw of this.FileWatcher) {
			fw[1].close();
		}
		this.FileWatcher.clear();
		for (var m0 of m) {
			var paths = path.resolve(this.workspace.uri.fsPath, m0);
			if (!fs.existsSync(paths))
				continue;
			this.createwatch(paths);
		}
	}

	private createwatch(paths: string) {
		let w: fs.FSWatcher;
		let jname: string;
		if (fs.lstatSync(paths).isDirectory()) {
			jname = paths;
		} else {
			jname = path.dirname(paths);
		}
		w = fs.watch(paths, (event, filename) => {
			this.filechange(filename, jname);
		});

		this.FileWatcher.set(paths, w);
	}

	/* default skip any xunit or nunit assemblies. assumption that 
	 * only xunit/nunit dll will begin with those letters
	 */
	private skipfiles(modules: string[]) {
		let fnd: string[] = [];
		let pat = this.GetConfigPara("skippattern");
		// /nunit\\..*\\.dll|xunit\\..*\\.dll/i
		var regex = new RegExp(pat!, 'i');

		for (var s of modules) {
			var f = path.basename(s).match(regex);
			if (f == null)
				fnd.push(s)
		}
		return fnd;
	}
}
