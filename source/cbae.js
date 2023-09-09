#! /usr/bin/env node
/**
 * CBAE - Cue Bin Audio Encoder
 * -- This is the development version, the final script is minified
 * -- (jLib) is a personal library
 * ---------------------------------
 * Author: John32B
 * Project homepage: https://github.com/john32b/cbae
 * Log:
 * Date: (2023_08) V1.1 ECMAscript Modules | -sh option to produce short names | 
 * Date: (2023_02) v1.0 Hashes, extract Raw, only data/audio
 * Date: (2022_07) v0.9 First Published Version
 * ----------------------------------
 * Dev Notes:
 * - I am using 'tsconfig.json' to enable Typerscript parsing
 *   in VSCode just to get intellisense. I am not using
 *   Typescript to compile anything. 
 * - JLIB is a TypeScript codebase, but the .js files
 *   should already be compiled externally.
***************************************************************/
 
import * as FS from 'node:fs';
import PATH from 'node:path';
import { cpus } from 'node:os';
// --
import D from "jlib";
const {L, T, APP, tools:TL} = D;  // shorthands
import * as TT from 'jlib/util/TerminalTools';
import * as TFS from 'jlib/util/FsTools';
import {Proc2} from 'jlib/util/Proc2';
// --
import {cdinfos} from './cdinfos.js';


// Logging 
// L.set({ level: 4, file: "a:\\log_cbae.txt", pos: true, stderr: false });
// L.set({ date: "", level: 4, file: "/tmp/log_cbae.txt", pos: true, stderr: true });

// Use 3/4 of total threads for operations
const DEF_THREADS = Math.ceil(cpus().length * 0.75);

// -------------------------------------------------------;

const FFMPEG = {
		
	// String to force RAW CDDA format. Can be used for input and output as well
	rawStr : '-f|s16le|-ar|44100|-ac|2',

	/** Encoders and predefined strings 
	 * - The handler will auto CLAMP the bitrate for get() using {min} {max}
	 * - get(bitrate) will return a full ffmpeg encoding string
	 **/
	enc : {

		MP3 : {
			// https://trac.ffmpeg.org/wiki/Encode/MP3
			name: "Mp3", ext: ".mp3", pf: 'k Cbr', min: 32, max: 320,
			get (b) { 
				return `-c:a|libmp3lame|-b:a|${b}k`
			}
		},
		
		MP3V : {
			// http://www.powyslug.org.uk/files/Converting_to_mp3_files_using_ffmpeg.pdf
			name: "Mp3", ext: ".mp3", pf: 'k Vbr', min: 44, max: 256,
			get (b) { 
				// Gets an integer from 0-9. Reverses it, so 0 is highest Quality
				return '-c:a|libmp3lame|-q:a|' +
					TL.clamp(9 - Math.round(9 * (b - 44) / (212)), 0, 9);
					// DEV : inlined maths, 212 = max-min
			}
		},

		VORBIS: {
			// https://wiki.hydrogenaud.io/index.php?title=Recommended_Ogg_Vorbis#Recommended_Encoder_Settings
			// Docs say -1,-2 quality, but ffmpeg does not support it. Start with 0
			// Supports Fractions in quality so -q 4.5 is valid (precision 2 tested OK)
			name: "Vorbis", ext: ".ogg", pf: 'k Vbr', min: 64, max: 500,
			get(b) {
				let q = [64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 500], ind1 = 0;
				// if(q.indexOf(b)>=0) found = q.indexOf(b); I could do this and save calculations but I don't care
				while (b > q[ind1++]);
				if (ind1 > 10) ind1 = 10;
				let min = q[ind1 - 1];
				let ratio = (b - min) / (q[ind1] - min);
				return '-c:a|libvorbis|-q|' + TL.roundFloat(ind1 - 1 + ratio, 2);
				// ^ Return a number from 0-10 depending on array position of bitrate
			}
		
		},

		OPUS: {
			// https://ffmpeg.org/ffmpeg-codecs.html#libopus
			name: "Opus", ext: ".opus", pf: 'k Vbr', min: 28, max: 500,
			get(b) {
				return `-c:a|libopus|-vbr|on|-compression_level|10|-b:a|${b}k`;
			}
		},

		FLAC: {
			name: "Flac Lossless", ext: ".flac",	// Lossless don't need the {min,max} fields
			get() { return '-c:a|flac'; }
		},

		RAW: {
			name: "CDDA Raw", ext:".bin",
			get() { return '-c:a|pcm_s16le|-f|s16le|-ar|44100|-ac|2'; }
		}
	},

	/**
	 * Formatted ENC strings are like "MP3:56" | CODEC:KBPS 
	 * 		CODEC : is the name of the field in {enc}
	 * 		KBPS : is a value from CODEC.min -> CODEC.max | Will clamp |
	 * @returns {{str:String, ext:String, desc:String}} .str : the ffmpeg string | .ext : extension | .desc : description 
	 * Returns <null> for error
	 */
	getEnc:function(str)
	{
		if(!str) return null;
		let S = str.toUpperCase().split(':');
		
		let e = this.enc[S[0]]; // Get codec object
		if(!e) return null;	// Could not find

		// Preliminary Object Build
		let o = { ext:e.ext, desc:e.name, str:null }; 

		let kb = parseInt(S[1]);
		if(Number.isNaN(kb)) {
			if(e.max) 			// Unless it is a Lossless codec
				return null;	// Expecting a number. Error
		}
		
		if (e.max) { 
			kb = TL.clamp(kb, e.min, e.max);
			o.desc += ` ${kb}${e.pf}`;
		}

		o.str = e.get(kb);
		return o;
	}// -------------------------;

}// -------------------------------------------------------;



/** Promise, get SHA1 of file/part of file . @throws */
async function FilePartSHA1(source, readStart = 0, readLen = 0)
{
	let stat; 
	try{ stat = FS.statSync(source); } catch(er) {
		throw `Cannot read file '${source}'`;
	}

	// Only bother importing these if it has to
	var crypto = await import('node:crypto');
	var pipeline = await import('node:stream/promises');
	var hash = crypto.createHash('sha1');

	let srcSize = stat.size;
	if (readLen == 0) readLen = srcSize - readStart;	// to the rest of the track
	// DEV: it needs the -1 for readEnd because it is inclusive | i.e. (readStart to readStart) would read 1 byte
	// Actual ending position to read
	let readEnd = readStart + readLen - 1;
	L.debug("Reading SHA1 for ", source, readStart, readEnd);

	// - NEW: Promise way of handling pipes
	let fd = await FS.promises.open(source, 'r');
	let strIn = fd.createReadStream({start:readStart, end:readEnd});
	await pipeline.pipeline(strIn, hash);
	return hash.digest('hex');

}// -- end fn --



/** SYNC
 * Return a unique path to put the generated CD track files
 * - Tests if it can be created
 * - If exists, will increment a counter at the end of the path (2) until unique
 * 
 * @param {cdinfos} cd
 * @param {String} out The output path to create the subfolder. If null will set to same as input file 
 * @returns {String} the actual path that was created
 * @throws {String} When can't create
 */
function createOuputDir(cd, out)
{
	let path = out??cd.FILE_DIR;
	path = PATH.resolve(PATH.normalize(path));
	path = PATH.join(path, cd.CD_FILE);
	path += ' [e]' // encoded;

	if(ONLY) {
		path += ` [only ${ONLY}]`;
	}

	// Rename it like windows does, adds (1).. (2).. (3) at the end of the path
	while(FS.existsSync(path))
	{	
		let res = /\((\d+)\)$/.exec(path);
		if(!res) {
			path += ' (2)';	// START counting at 2
		}else{
			// Increment the (x) by one
			path = path.slice(0,res.index);
			path += '(' + (parseInt(res[1]) + 1) + ')';
		}
	}
	
	L.log(`Creating CD output dir "${path}"`);
	try{
		FS.mkdirSync(path,{recursive:true});
	}catch(e){
		L.error(" .. FAILED");
		throw `Cannot create : "${path}"`;
	}
	return path;
}// -------------------------;



/**
 * Called on PROGRAM EXIT 
 * Prints infos only if there were more than 2 files in the input queue
 * @param {Boolean} ue User Abort??
 **/
function printEStats(ue)
{
	// DEV: Starts after a line in clean position
	let t = ELOG.inputs.length;
	if(t<2) return;
	T.pac(` >> 'Input' (${t}) Cue Files\n`);
	T.pac(` >> [Encoded] (${ELOG.success}/${t}) \n`);

	let func = (map,str)=>{ if(map.size) {
		T.pac(` >> ${str[0]} (${map.size}/${t}) ${str[1]}`);
		let c=0;
		map.forEach((v,k) => {
			T.pac(`\t${++c}.'${ELOG.inputs[k]}' -- {${v}}\n`);
		});
	} };		
	func(ELOG.skip,['{Skipped}','\n']);
	func(ELOG.error,['{Failed}','\n']);

	// T.pac(` >> Total Raw Size : ${TL.bytesToMBStr(ELOG.size0)}MB | Encoded Size ${TL.bytesToMBStr(ELOG.size1)}MB\n`);
	T.n();
	if(ue) {
		T.ptag("<:darkmagenta,white> >> USER ABORTED  <!,n>");
	}
}// -------------------------;

/**
 * Whole task of encoding a CD.
 * @param {String} file A cue file to process
 */
function taskEncodeCD(file) { return new Promise( (res, rej) => 
{
	// DEV: I am making this an explicit Promise, because I need access to reject()
	// DEV: Only the errors that are sure to break the whole queue will panic

	let time0 = Date.now(); // Unix Time
	
	let cd = new cdinfos();
		cd.loadCue(file); // *THROWS {String}
	
	// This is the only SKIP case (error starting with +) There is no point in converting this CD
	if (cd.tracks.every(t => t.isData)) throw "+CD has no Audio Tracks";

	// Hold the bytes of all tracks encoded + data | Used for info only
	let encSize = 0;

	let out0 = APP.output;
	if (out0 == "=src") out0 = null; // force "same dir as cue file"

	// This will create a unique output dir to put the tracks
	let outDir = createOuputDir(cd, out0); // *THROWS {String}
	workingDir = outDir;

	// >> Declare how the tracks are going to be named
	let templ = null;
	if(APP.option.sh) templ = "track{no}";
	if(APP.option.tname) templ = APP.option.tname;
	cd.prepareFilenames(templ);

	let z="  - ";	// Formating Text
	// T.pac(`${z}Output : "${(out0?outDir:"same as .cue")}"\n`);
	T.pac(`${z}Output : "${outDir}"\n`);
	if(ONLY=="data") {
		T.pac(`${z}Processing `);
	}else{
		T.pac(`${z}Audio Enc : '${ENC.desc}'\n`);
		if(ENC.ext==".bin")
			T.pac(`${z}Copying Tracks `);
		else
			T.pac(`${z}Converting Tracks `);
	}
	
	// Visual indication that something is going on, along with tasks/maxtasks
	TT.Prog.start(cd.tracks.length);

	/**
	 * Generator that returns Promises to process each track of the CD
	 * Either copy bytes to new files / encode audio to new files
	 */
	const genTrackTask = function*() {

		for(let i=0; i<cd.tracks.length; i++)
		{
			let tr = cd.tracks[i];
			let outFile = PATH.join(outDir,cd.readyFiles[i]);
			let copyData = tr.isData || (ENC.ext==".bin");

			if( (tr.isData && ONLY=="audio") || (!tr.isData && ONLY=="data") )
			{
				yield new Promise(r=>r());	// Skip it. Promise that immediately resolves
				continue;
			}

			if(copyData) 
			{
				encSize += tr.byteSize;
				yield TFS.copyPart(cd.getTrackFilePath(i), `${outFile}.bin`, tr.byteStart, tr.byteSize);
 			}
			else // -- IS AUDIO TRACK
			{
				let strIn = FS.createReadStream(cd.getTrackFilePath(i),{ start: tr.byteStart, end: tr.byteStart + tr.byteSize - 1, flags: 'r' });
				let ff = new Proc2("ffmpeg");
				let prom = ff.startP(`-y|${FFMPEG.rawStr}|-i|pipe:0|${ENC.str}|${outFile + ENC.ext}`);
				ff.proc.prependListener('close', (s)=>{
					// > Get the encoded size of the file. FFMPEG gives out the KB of the file
					// The last 120 characters of the FFMPEG output Should contain :
					// "video:0kB audio:17994kB subtitle:0kB other streams:0kB global headers:0kB muxing overhead: 0.044981%"
					// DEV, not checking for s>0 because if error,it will do nothing
					let inf = ff.logExit.err.slice(-120); 
					let res = /audio:(\d+)kB/.exec(inf);
					if(res) encSize += parseInt(res[1])*1024;
				});
				strIn.pipe(ff.stdin);
				yield prom;
			}

		} return 0;
	}// -------------------------;

	// --
	// DEV: PromiseRun will exec promises in parallel with a hard limit
	TL.PromiseRun(genTrackTask(), APP.option.p ?? DEF_THREADS, (progress) => {
		
		TT.Prog.setTask(progress, cd.tracks.length);

	}).then(() => {
		
		// -- All tracks encoded.
		TT.Prog.stop();

		// This string "600MB -> 200MB" is used both in the .cue file and printed on console
		let byteStr = `${TL.bytesToMBStr(cd.CD_SIZE)}MB -> ${TL.bytesToMBStr(encSize)}MB`;

		// DEV : Writing, from the [OK] positionm
			// - Converting Tracks [OK]
			// - CD Size : 624MB -> 41MB  | time 00m:07s

		T.pac(`[OK]\n`);
		T.pac(z + `CD Size : ` + byteStr);
		T.ptag('<darkgray,it> | time ' + new Date(Date.now() - time0 + 500).toISOString().slice(14,19).replace(':',"m:") + 's<!,n>'); // hh:(mm:ss)

		// --> Write the new CUE file
		let c = ['REM ' + '-'.repeat(50)];
			c.push('REM | ' + cd.CD_TITLE);
			c.push(c[0]); // Add the `---` line again
			c.push(`REM | Converted with CBAE v${APP.infos().ver} - Cue/Bin Audio Encoder`);
			c.push(`REM | CD Size : ${byteStr}`);
			c.push('REM | Audio Quality : ' + ENC.desc);
			c.push(c[0], ''); 
			c = c.concat(cd.buildCueFileForCBAE(ENC.ext));

		let cuef = cd.CD_FILE + (ONLY?" (partial)":"") + ".cue";
		try{
			L.log("> All tracks Complete. Writing CUE file");
			FS.writeFileSync(PATH.join(outDir, cuef), c.join('\n'));
		}catch(e) {
			throw [`Failed to write : '${cuef}'`]; //-> DEV: String[]
		}

		ELOG.success++;
		ELOG.size0 += cd.CD_SIZE;
		ELOG.size1 += encSize;
		workingDir = null;

	}).catch(er=>{  

		console.error(er);
		// Here are errors from ::
		// 		- TFS.copyPart > Readable String Errors
		// 		- Proc2 > logExit Object with stdErr/stdOut
		//		- the then() above, if it can't write the cue file
		
		if(TT.Prog.stop()) {
			T.n();	// Make sure The ERROR print on the parent starts at a new line.
		}


		// If a task fails, I need to rename the OutPut folder to xxx_(failed) + unique
		// Using EPOCH time, it should cover duplicate folder names
		FS.renameSync(outDir,`${outDir} (${Date.now()}) (failed)`);

		er = er[0];	// Just take the first error from the stack
		
		if(typeof(er)=='string') {
			rej(er);
		}else{
			// I can't bother extracting the exact error
			// rej("FFmpeg : " + er.err.split('\n').last(2)); // Usually it is : Conversion Failed!
			// Assuming that FFMPEG sent that error. What else could it be?
			rej("FFmpeg general error. Not enough disk space?");
		}

	}).then( res );

})}// -------------------------------------------------------;



APP.init({
	name:"CBAE", ver:"1.2", desc:"Cue/Bin Audio Encoder",
	actions:{
		e : "!Encode cue/bin to output folder. Will create the new<|>track files and the new .cue file under a subfolder", // ! means default, it will set this action if you dont set any
		i : "Display cue/bin information along with SHA1 checksum of tracks ",
		// r : "Restore encoded audio cd back to raw audio tracks", -- future? --
	},
	options:{
		enc : [	"Audio Codec String <yellow>ID:KBPS<!> <|>"+
				"List of supported Encoders:<|>" +
				"<yellow>MP3<!>:(32-320) Constant Bitrate | <yellow>MP3V<!>:(44-256) Variable Bitrate <|>" +
				"<yellow>VORBIS<!>:(64-500) | <yellow>OPUS<!>:(28-500) | <yellow>FLAC<!> | <yellow>RAW<!> <|>" +
				"<darkgray,it> e.g. -enc OPUS:64 , -enc FLAC, -enc VORBIS:320<!>", 1],
		p  : ["Set max parallel operations.", 1, DEF_THREADS],		// description,required,default value (just for help)
		sh : ["Short filenames for new Tracks | <darkgray>e.g. 'track01.bin track02.ogg ..'<!><|><darkgray>soon to be deprecated in favor of -tname<!>"],
		only : ["Process only <yellow>{data, audio}<!> from the tracks<|>For advanced use <darkgray>| e.g. -only audio<!>",1],
		tname: ["Customize tracknames with a template string.<|>Valid Tags <darkyellow>{no} {cdt} {tt} {ta} <darkgray> | e.g. \"track{no}\"<!>",1]
	},

help:{ 
io:"Io",
// Dev: Literal Strings, Keep them at the start of the line.
info:
`<darkgray>  Author : John32B | https://github.com/john32b/cbae <!,n>\
  Encodes the Audio Tracks of a cue/bin CD image and builds a new .cue file`,
		
usage:
`<t,magenta>input:<!> .cue files only. Supports multiple files.<n,t,magenta>output:<!> \
A new folder will be created for each cue/bin in this folder.<n,t,t>\
You can use <yellow>=src<!> for source folder`,

post: 
`<magenta>Notes:<!,darkgray>\
\tUsing the <darkyellow>RAW<darkgray> encoder will just copy the audio tracks as they are,<n>\
\tthis is useful for cutting .bin files to individual track files.`}

});



// -------------------------------------------------------;
// :MAIN
// -------------------------------------------------------;

	// FFMPEG Global Encoding string that was parsed.
	// Gotten once on init and used on all inputs later
	/** @type {{str:String, ext:String, desc:String}} */
	var ENC;

	// Encoding Operation Log, used for printing infod
	var ELOG = {
		inputs:null,		// This is just a copy of APP.inputs
		success:0,
		error: new Map(),	// <inputs index:int, Error:String>
		skip: new Map(),	// <inputs index:int, Error:String>
		size0:0,			// Success CD raw size total
		size1:0				// Success CD encoded size total
	};

	var workingDir = null;	// Keep the output folder the the current working task

	T.setCur(false);
	APP.printBanner();

	var ONLY = APP.option.only;
	if(ONLY=="data") APP.option.enc="RAW";	// HACK: Avoid errors when checking for audio codec later.

	// -------------------------;

	if(APP.input.length==0)
	{
		T.ptag("use <yellow>--help<!> for help<n>");
		process.exit(0);
	}

	if(APP.action=='i') //:action:i
	{
		APP.assertIO('im');
		L.log('> Action: Information ::');
		let qlen = APP.input.length;
		let qnow = 0;

		APP.input.queueRun( (inp, next0) => {
			if (!inp) {
				process.exit(0); 
			}
			let ts = qlen > 1 ? `(${++qnow}/${qlen}) ` : '';	// Puts a (1/10) after Input
			T.pac(`\n==> Input ${ts} : "${inp}"\n`);
			let cd = new cdinfos();
			try{
				cd.loadCue(inp);
			}catch(e){
				L.error(e);
				T.pac(`  > {ERROR} : ${e}\n`);
				return next0();
			}

			let X=TL.bytesToMBStr; // shortcut
			let auds= cd.getAudioSize();

			T.pac(`  > CD Title:'${cd.CD_TITLE}' | Size:${X(cd.CD_SIZE)}MB (Data:${X(cd.CD_SIZE-auds)}MB Audio:${X(auds)}MB) | Tracks ${cd.tracks.length}\n`);

			// DEV: queueRun exhausts the array, but I need it intact, that's why I am cloning it
			// 		queueRun is defined in `jlib/util/tools`
			[...cd.tracks].queueRun( (tr, next) => {
				if(!tr) return next0();	// Devnote: Automatic new event loop tick
				T.pac(`\t> Track${tr.noStr} | Type:${tr.type.padEnd(10)} | `);
				FilePartSHA1(cd.getTrackFilePath(tr.no-1), tr.byteStart, tr.byteSize)
				.then( (sha1)=>{
					T.pac(`Size:${X(tr.byteSize).padStart(3)}MB | SHA1: ${sha1}\n`);
				})
				.catch(er=>{
					T.pac(`{ ERROR READING } | file ${file} \n`);
				})
				.finally(next);
			});
		});

	}// -- end action (i)
	

	if(APP.action=='e')	// :action:e
	{
		APP.assertIO('imo');
		
		L.log('> Action: Encode ::');
		// Original queue length
		let qlen = APP.input.length;
		// Current queue index
		let qnow = 0;
		// Print a deco line
		let printLine = () => T.ptag('  <darkgray>' + '-'.repeat(40) + "<!,n>");

		ELOG.inputs = [...APP.input];

		// Important checks, Errors will quit the program
		try {
			if(!Proc2.checkRun('ffmpeg -version')) throw 'Cannot run ffmpeg. Is it set on path?'; 
			if(!APP.option.enc) throw "You need to set an encoder with '-enc'";
			ENC = FFMPEG.getEnc(APP.option.enc);
			if(!ENC) throw "Encoding String Error."
		}catch(er){
			APP.panic(T.autoColor(er));
		}

		// - This is called on before any program exit, Normal user Cancel
		//   Print out the File Queue stats (if more than one file)
		process.prependOnceListener('exit',(c)=>{
			TT.Prog.stop(); // DEV: Safe to call, if not running, nothing will happen
			if(c==1223) {
				T.ptag("<:darkmagenta,white> USER ABORT <!,n>");
				printLine();
				if(workingDir) {
					try{
						FS.renameSync(workingDir,`${workingDir} (ABORTED)`);
					}catch(e){}
				}
			}
			printEStats(c==1223);
		});

		// -- Run 'taskEncodeCD' for each input file. Wait until it completes
		APP.input.queueRun( (inp, next) => {

			if (!inp) {
				process.exit(0);  // -> Will exit and autocall the user 'exit' event listener
			}
			
			// DEV: - First line of Info Report,
			//		- The taskEncodeCD will print more infos lines 
			// Prints: "(1/12)" when multiple files
			let ts = qlen > 1 ? `(${qnow+1}/${qlen}) ` : '';
			T.pac(`==> Input ${ts} : "${inp}"\n`);

			// > Start processing
			taskEncodeCD(inp)
			.catch(er=>{
				// Dev: Cursor is at a newline, er:String
				// Warn/Log the error and continue
				let m;
				if(er.charAt(0)=="+"){
					er = er.slice(1);
					ELOG.skip.set(qnow, er);
					m="{warning}";
				}else{
					ELOG.error.set(qnow, er);
					m="{ERROR}";
				}
				L.error(er);
				T.pac(`\t${m} : ${er}`).ptag(' | <cyan,it>skipping<!,n>');
			})
			.then( ()=>{
				qnow++;
				printLine();
				next();
			});
		});

	}// -- end action (e)