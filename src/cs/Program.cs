using System;
using System.Diagnostics.SymbolStore;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using Mono.Cecil;
using Mono.Cecil.Cil;
using System.Collections.Generic;
using Mono.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Xml;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Globalization;
using System.Text.RegularExpressions;
using Xunit;
using Xunit.Abstractions;


namespace TestExplorer {
class Program {
	static void usage()
	{
		Console.Error.WriteLine("testrun  -x <xunit location> -n <nunit location> " +
		    "-m <mono location> " + 
			" [discover -t <semicolon sep target directory or assembly> | " +
		    "run -t <semicolon sep target directory or assembly> " + 
			" -am <semicolon sep methodname> -ac <semicolon sep classname> | " +
		    "debug  -t <target assembly> -am <methodname> ]");
		Environment.Exit(1);
	}

	class TestInfo {
		public string type;
		public string modname;
		public List<TestCase> tests;

		public void Print(int run)
		{
			if (run == 0)
				Console.WriteLine("{0};{1}", type, modname);

			foreach(var t in tests) {
				t.Print(run);
			}
			Console.WriteLine();
		}
	}

	class TestCase: IComparable<TestCase> {
		public string test;
		public string name;
		public string time;
		public string result;
		public string msg;
		public string stack;
		public string source;
		public string lineno;

		public static implicit operator string(TestCase rhs)
		{
			return rhs.name;
		}

		public static implicit operator TestCase(string rhs)
		{
			return new TestCase(rhs);
		}

		public TestCase(string n=null, string c=null, string t=null, string r=null,
		    string m=null, string s=null)
		{
			name = n;
			test =c;
			time =t;
			result=r;
			msg=m;
			stack=s;
		}

		public int CompareTo(TestCase tests)
		{
			// A null value means that this object is greater.
			if (tests == null)
				return 1;
			else
				return (this.name).CompareTo(tests.name);
		}

		public void Print(int run)
		{
			string n = test != null ? test: name;

			if (run != 0) {
				string msg0 = null;
				if (msg != null) {
					msg0 = msg.Replace("\r", "");
					msg0 = msg.Replace("\n", ", ");
				}
				Console.WriteLine("{0};{1};{2};{3};{4};{5}",
				    n, result, time, lineno, source, msg0);
			} else
				Console.WriteLine("{0};{1};{2}", n, source, lineno);
		}
	}

	static string FullPath(string path)
	{
		path = Environment.ExpandEnvironmentVariables(path);
		if (Path.IsPathRooted(path) == false)
			return Path.GetFullPath(path);

		return path;
	}

	static string xrunner="", nrunner="", monoexe="";
	static bool usemono = false;

	static void Main(string[] args)
	{
		int arg = 0, depth=0;
		int runmode=0;
		List<TestInfo> ltest = new List<TestInfo>();
		List<string> target = new List<string>(),
		methods=new List<string>(), types=new List<string>();

		if (args.Length == 0) {
			usage();
		}

		while (arg < args.Length) {
			switch (args[arg]) {
			case "discover":
				runmode = 0;
				break;
			case "run":
				runmode = 1;
				break;
			case "debug":
				runmode = 2;
				break;
			case "-m":
				usemono = true;
				monoexe = args[++arg];
				break;
			case "-x":
				xrunner = args[++arg];
				xrunner = FullPath(xrunner);
				break;
			case "-n":
				nrunner = args[++arg];
				nrunner = FullPath(nrunner);
				break;
			case "-t":
				var s = args[++arg];
				target = s.Split(new[] { ';' },
				        StringSplitOptions.RemoveEmptyEntries).ToList();
				break;
			case "-am":
				var sa = args[++arg];
				methods = sa.Split(';').ToList();
				break;
			case "-ac":
				var sc = args[++arg];
				types = sc.Split(';').ToList();
				break;
			case "-d":
				depth = Convert.ToInt32(args[++arg]);
				break;
			default:
				usage();
				return;
			}
			++arg;
		}
		if (nrunner == "")
			nrunner = SearchRunner(1);
		if (xrunner == "")
			xrunner = SearchRunner(0);
		if (xrunner == null && nrunner == null) {
			Console.Error.WriteLine("Unit runners missing");
			return;
		}

		if (runmode==0)
			ltest = ProcessTests(runmode, target,ltest);
		else {
			if (target.Count > 1 && (methods.Count !=0 || types.Count != 0)) {
				usage();
				return;
			}
			ltest = ProcessTests(runmode,target, ltest, types, methods);
		}
		int count = 0, mod = 0;
		foreach (var t in ltest) {
			int c = t.tests.Count;
			if (c > 0) {
				string str;
				count += c;
				mod++;
				if (runmode == 0)
					str = String.Format("{0} tests found in {1}", c, t.modname);
				else
					str = String.Format("{0} tests run in {1}", c, t.modname);

				Console.Error.WriteLine(str);
			}
		}

		if (count > 0) {
			string str;
			if (runmode == 0)
				str = String.Format("Total {0} tests found in {1} assemblies", 
				    count, mod);
			else
				str = String.Format("Total {0} tests run in {1} assemblies", 
				    count, mod);
			Console.Error.WriteLine(str);
		}
		return;
	}

	static void AddSourceInfo(List<TestCase> to, List<TestCase> from)
	{
		int ct0 = to.Count, cf0 = from.Count;
		TestCase t0, f0;
		int it = 0, jf = 0;

		while(it < ct0 && jf < cf0) {
			t0 = to[it];
			f0 = from[jf];

			string f0n = f0.name;
			string t0n = t0.name;
			t0n = t0n.Substring(0, t0n.LastIndexOf('(') > 0 ? t0n.LastIndexOf('('):t0n.Length);
			if (t0n.Equals(f0n)) {
				t0.source = f0.source;
				t0.lineno = f0.lineno;
				it++;
			} else if (t0n.CompareTo(f0n) > 0)
				jf++;
			else
				it++;
		}
	}

	static string SearchRunner(int unit)
	{
		string pat = null, exe = null;
		var p = Directory.GetCurrentDirectory() + "/packages";
		if (!Directory.Exists(p))
			return null;
		if (unit == 0) {
			pat = "xunit.runner.console*";
			exe = "/tools/xunit.console.exe";
		} else {
			pat = "NUnit.ConsoleRunner*";
			exe = "/tools/nunit3-console.exe";
		}

		string[] xl = Directory.GetDirectories(p, pat);
		if (xl.Length > 0) {
			string xexe = xl[0]+ exe;
			if (File.Exists(xexe))
				return xexe;
		}

		return null;
	}

	static List<TestInfo> ProcessTests(int mode, List<string> targets, List<TestInfo> ltest,
	    List<string> types=null, List<string> methods=null, int depth=0)
	{
		foreach (string s in targets) {
			if (File.Exists(s)) {
				ltest =  ProcessTestsinFile(mode, FullPath(s), ltest, types, methods);
			} else if (Directory.Exists(s)) {
				var ns = Directory.GetFiles(s, "*.dll");
				ltest =  ProcessTests(mode, ns.ToList(), ltest,types,methods);
				if (depth > 0) {
					var ds = Directory.GetDirectories(s);
					ltest =  ProcessTests(mode, ds.ToList(), ltest,types,methods, --depth);
				}
			} else {
				Console.Error.WriteLine("Error: In target name {0}", s);
				return ltest;
			}
		}
		return ltest;
	}

	static List<TestInfo> ProcessTestsinFile(int mode, string f, List<TestInfo> ltest,
	    List<string> types=null, List<string> methods=null)
	{
		int i;
		TestInfo t = null;

		if ((i=TestModuleType(f)) == 0)
			return ltest;
		if (i >= 2) {
			t = NunitRunner(mode, f, types, methods);
			if (t != null)
				ltest.Add(t);
			i -= 2;
		}
		if (i == 1) {
			t = XunitRunner(mode, f, types, methods);
			if (t != null)
				ltest.Add(t);
		}
		if (t != null) {
			if (mode==0) {
				List<TestCase> tc;

				tc = Monoc(t.modname, t.tests);
				AddSourceInfo(t.tests, tc);
			}
			t.Print(mode);
		}

		return ltest;
	}

	static List<TestCase> XmlRead(string xml, int run, List<TestCase> lst)
	{
		using (XmlReader reader = XmlReader.Create(xml)) {
			while (reader.Read()) {
				// Only detect start elements.
				TestCase t0 = null;
				if (reader.IsStartElement()) {
					if (reader.Name == "test-case") { //nunit
						string name = reader["fullname"];
						if (name == null)
							name = Regex.Unescape(reader["name"]);
						var m = reader["methodname"];
						var c = reader["classname"];

						if (m != null & c != null)
							t0 = new TestCase(c+'.'+m, name);
						else
							t0 =  new TestCase(name, name);

						lst.Add(t0);

					} else if (reader.Name == "test") { //xunit
						var name = reader["name"];
						var m = reader["method"];
						var c = reader["type"];

						if (name == null && m == null && c == null)
							continue;
						name =  Regex.Unescape(name);
						if (!name.Contains(c))
							name = c+'.'+name;

						if (m != null & c != null)
							t0 = new TestCase(c+'.'+m, name);
						else
							t0 =  new TestCase(name, name);
						lst.Add(t0);
					}
					if (run != 0 && t0 != null) {
						t0.result = reader["result"];
						t0.time = reader["time"];
						//xunit returns Failure
						if (t0.result == "Failure" || t0.result == "Fail")
							t0.result = "Failed";
						if (t0.time == null)
							t0.time = reader["duration"];
						if (t0.result == "Failed") {
							if (reader.ReadToDescendant ("message"))
								t0.msg = reader.ReadElementContentAsString();
							if (reader.ReadToNextSibling("stack-trace"))
								t0.stack = reader.ReadElementContentAsString();
							Tuple<string, int> d = DebugInfo(t0.stack);
							if (d != null) {
								t0.source = d.Item1;
								t0.lineno = d.Item2.ToString();
							}
						}
						t0 = null;
					}
				}
			}
		}
		return lst;
	}

	static Tuple<string,int> DebugInfo(string stack)
	{
		string begin = " in ";
		string sep = ":";
		if (stack == null)
			return null;
		int st = stack.IndexOf(begin, 0);
		if (st == -1)
			return null;
		int et = stack.LastIndexOf(sep);
		if (et == -1)
			return null;


		st += begin.Length;
		string s = stack.Substring(st, et-st);
		char[] charsToTrim = { ' ', '\n', '\r'};
		s = s.Trim(charsToTrim);
		if (File.Exists(s) == false)
			return null;

		string li = stack.Substring(et+1, stack.Length - (et+1));
		string no = Regex.Match(li, @"\d+").Value;
		int n;
		int.TryParse(no, out n);
		return new Tuple<string, int>(s, n-1);
	}

	static Assembly AssemblyResolve(object sender, ResolveEventArgs args)
	{
		string dir = Directory.GetCurrentDirectory();
		string file = Path.Combine(dir, args.Name.Split(',')[0]);
		string[] exts = {".dll", ".exe"};

		System.Reflection.Assembly assm = null;
		foreach (var ext in exts) {
			string f = file+ext;
			if (File.Exists(f)) {
				try {
					//assm = Assembly.LoadFile(f);
					assm = Assembly.LoadFrom(f);

					if (assm != null)
						return assm;
				}  catch (Exception e0) {
					Console.Error.WriteLine("Error Resolving {0}, {1}",f, e0.ToString());
				}
			}
		}
		return null;
	}

	static List<TestCase> XunitDiscover(string fn, List<TestCase> lst)
	{
		string olddir = Directory.GetCurrentDirectory();
		Directory.SetCurrentDirectory(Path.GetDirectoryName(fn));
		AppDomain.CurrentDomain.AssemblyResolve += AssemblyResolve;


		XunitProjectAssembly assembly = new XunitProjectAssembly();
		assembly.AssemblyFilename = fn;
		assembly.Configuration.AppDomain = AppDomainSupport.Denied;

		assembly.Configuration.PreEnumerateTheories = true;

		var options = TestFrameworkOptions.ForDiscovery(assembly.Configuration);
		var domain = assembly.Configuration.AppDomainOrDefault;
		try {
			using (var controller = new XunitFrontController(domain,
			    assembly.AssemblyFilename)) {
				using (var sink = new TestDiscoverySink()) {
					controller.Find(false, sink, options);
					sink.Finished.WaitOne();

					var count = sink.TestCases.Count;
					foreach (var t in sink.TestCases) {
						var n = t.TestMethod.TestClass.Class.Name;
						var m = t.TestMethod.Method.Name;
						var d = t.DisplayName.Contains(n) ? 
						    t.DisplayName: n+'.'+t.DisplayName;
						TestCase t0 = new TestCase(n+'.'+m, d);
						lst.Add(t0);
					}
				}
			}
		} catch (Exception e) {
			Console.Error.WriteLine("{0} {1} {2}", fn, e.ToString(), e.Message);
		}
		AppDomain.CurrentDomain.AssemblyResolve -= AssemblyResolve;
		Directory.SetCurrentDirectory(olddir);
		return lst;
	}

	static TestInfo XunitRunner(int run, string f,
	    List<string> types=null, List<string> methods=null)
	{
		List<TestCase> lst = new List<TestCase>();
		string args = null, cons = f;
		string exe, aargs;
		string tmps = System.IO.Path.GetTempFileName().Replace(".tmp", ".xml");

		if (types != null && types.Count > 0) {
			args = " -class "+ string.Join(" -class ",types.ToArray());
			cons += '|'+ string.Join("|", types.ToArray());
		}
		if (methods != null && methods.Count > 0) {
			// xunit doesnt run inline data functions indiviually ?
			foreach(var m in methods) {
				//method(ss) to method
				var s = m.Substring(0,m.IndexOf('(') == -1? m.Length:m.IndexOf('('));
				args += " -method " + s;
			}
			cons += '|'+ string.Join("|", methods.ToArray());
		}

		if (usemono) {
			exe = monoexe;
			aargs = " --debug " +  xrunner +' ' + f + args + " -xml " + tmps;
		} else {
			exe = xrunner;
			aargs = f + args + " -xml " + tmps;
		}

		if (run==1) {	//run tests
			Console.WriteLine("xunit;{0}", cons);
			Console.Out.Flush();
			RunTask(exe, aargs, f);
		} else if (run==2) {	//debug method
			var m = methods[0].Substring(0,methods[0].IndexOf('(') == -1 ?
			        methods[0].Length:methods[0].IndexOf('('));
			Console.WriteLine("xunit;{0};{1};{2};{3};{4};{5};{6}",
			    cons,xrunner, f,"-method", m, "-xml", tmps);
			Console.ReadLine();
		} else if (run == 0) {	//discover tests
			lst = XunitDiscover(f, lst);
		}

		if (run != 0 && File.Exists(tmps)) {
			lst = XmlRead(tmps, run, lst);
			File.Delete(tmps);
		}

		if (lst.Count == 0)
			return null;

		lst.Sort();
		TestInfo t = new TestInfo();
		t.modname = f;
		t.type = "xunit";
		t.tests = lst;

		return t;
	}

	static TestInfo NunitRunner(int run, string f,
	    List<string> types=null, List<string> methods=null)
	{
		string args, m = null, cons = f, exe;
		string tmps = System.IO.Path.GetTempFileName().Replace(".tmp", ".xml");
		List<TestCase> lst = new List<TestCase>();

		if (run==0) {
			args = f + " --explore="+tmps;
		} else {
			if (types != null && types.Count > 0) {
				m = string.Join(",", types);
				cons += "|" + string.Join("|", types);
			}
			if (methods != null && methods.Count > 0) {
				m = string.Join(",", methods);
				cons += "|" + string.Join("|", methods);
			}
			if (m != null)
				m = "--test="+m;
			args = f  +' '+m + " --inprocess" + " --result="+tmps;

		}

		if (usemono) {
			exe = monoexe;
			args = " --debug " + nrunner + ' ' + args;
		} else {
			exe = nrunner;
		}

		if (run != 2) {
			if (run == 1) {
				Console.WriteLine("nunit;{0}", cons);
				Console.Out.Flush();
			}
			RunTask(exe, args, f);
		} else {	//debug method
			Console.WriteLine("nunit;{0};{1};{2};{3};{4};{5};{6}",
			    cons, nrunner, f,m,"--inprocess", "--result",tmps);
			var s = Console.ReadLine();
		}

		if (File.Exists(tmps)) {
			lst = XmlRead(tmps, run, lst);
			File.Delete(tmps);
		}

		if (lst.Count == 0)
			return null;
		lst.Sort();
		TestInfo t = new TestInfo();
		t.modname = f;
		t.type = "nunit";
		t.tests = lst;

		return t;
	}

	static void RunTask(string exe, string args, string f)
	{
		Task<string> output = null, error=null;
		Process p = new Process();
		p.StartInfo.FileName = exe;
		p.StartInfo.Arguments = args;
		p.StartInfo.UseShellExecute = false;
		p.StartInfo.RedirectStandardOutput = true;
		p.StartInfo.RedirectStandardError = true;

		p.Start();
		output = Task.Run(() =>p.StandardOutput.ReadToEndAsync());
		error = Task.Run(() =>  p.StandardError.ReadToEndAsync());

		p.WaitForExit();

		if (error.Result.Length > 0 || output.Result.Contains("Exception")) {
			Console.Error.WriteLine("Error while running {0}", f);
			Console.Error.WriteLine(output.Result);
			Console.Error.WriteLine(error.Result);
		}
	}


	static int TestModuleType(string fn)
	{
		System.Reflection.AssemblyName[] assemblies;
		try {
			/* if path name with forward slash (/), loads all referenced assemblies??? */
			//string f0 = fn.Replace('\\', '/');
			assemblies = Assembly.LoadFile(fn).GetReferencedAssemblies();
		} catch (Exception) {
			return 0;
		}
		int x = 0, n = 0;
		if (assemblies.GetLength(0) == 0)
			return 0;
		foreach (var assembly in assemblies) {
			if (assembly.ToString().Contains("xunit"))
				x = 1;
			else if (assembly.ToString().Contains("nunit"))
				n = 2;
		}
		return x+n;
	}

	static List<TestCase> Monoc(string filename, List<TestCase> lis)
	{
		List<TestCase> methods = new List<TestCase>();

		string exactPath = Path.GetFullPath(filename);
		Assembly testdll = Assembly.LoadFile(exactPath);
		Mono.Cecil.ReaderParameters readerParameters = 
		    new Mono.Cecil.ReaderParameters { ReadSymbols = true };
		Mono.Cecil.AssemblyDefinition assemblyDefinition;
		try {
			assemblyDefinition = 
			    Mono.Cecil.AssemblyDefinition.ReadAssembly(filename, readerParameters);
		} catch(Exception) {
			readerParameters = new Mono.Cecil.ReaderParameters { ReadSymbols = false };
			assemblyDefinition = 
			    Mono.Cecil.AssemblyDefinition.ReadAssembly(filename, readerParameters);
		}

		Mono.Cecil.ModuleDefinition module = assemblyDefinition.MainModule;
		methods = ProcessTypes(module.Types, methods, lis);
		methods.Sort();

		return methods;
	}

	static List<TestCase> ProcessTypes(Collection<TypeDefinition> Types,
	    List<TestCase> methods, List<TestCase> lis)
	{
		foreach (Mono.Cecil.TypeDefinition type in Types) {
			if (type.NestedTypes != null)
				methods = ProcessTypes(type.NestedTypes, methods, lis);

			if (!type.IsPublic && !type.IsNested)
				continue;

			foreach (Mono.Cecil.MethodDefinition method in type.Methods) {
				var str = (type.FullName + '.' + method.Name).Replace('/', '+');
				var f = lis.Find(x => x.name == str);

				if (f != null)
					methods = AddTestCase(methods,method,type.FullName);
			}
		}
		return methods;
	}

	static List<TestCase> AddTestCase(List<TestCase> tests,
	    Mono.Cecil.MethodDefinition method, string c)
	{
		if (method != null) {
			var d = DebugInfo(method.Body);

			var s = c.Replace('/','+');
			TestCase t = new TestCase(s+'.'+method.Name);
			if (d != null && d.Item1 != string.Empty && d.Item2 != -1) {
				t.source = d.Item1;
				t.lineno = d.Item2.ToString();
			}
			tests.Add(t);
		}
		return tests;
	}

	static Tuple<string,int> DebugInfo(Mono.Cecil.Cil.MethodBody mbody)
	{
		string filename = string.Empty;
		int lineno = -1;
		if (mbody == null)
			return null;
		int i = 0;
		Mono.Cecil.Cil.SequencePoint sp;
		while (i < mbody.Instructions.Count) {
			if ((sp=mbody.Method.DebugInformation.GetSequencePoint(
			                mbody.Instructions[i++]
			            )) == null || sp.IsHidden)
				continue;
				
			filename = sp.Document.Url;
			lineno = sp.StartLine;
			break;
		}
		return new Tuple<string, int>(filename, lineno);
	}
}

}


