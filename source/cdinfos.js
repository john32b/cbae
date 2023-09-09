/**
 * cdinfos
 * --------
 * Simple parser for .cue files | Made for the 'cbae' tool
 * 
 * NOTE:
 *  This parser WILL NOT implement the entire specification
 *  just the parts that are usually used in Game CDs
 * 
 * Resources:
 *  + https://github.com/libyal/libodraw/blob/main/documentation/CUE%20sheet%20format.asciidoc
 *  + http://wiki.hydrogenaud.io/index.php?title=Cue_sheet
 */

import * as PATH from 'node:path';
import * as FS from 'node:fs';
import L from 'jlib/util/Log';
import {sanitizePath, getFileLines} from 'jlib/util/FsTools';


// When parsing cue files, if track type is not here, it will throw error
const SUPPORTED_TRACK_FILES = ["BINARY", "WAVE"];


// Number of Sectors a Track Type
const sectorsByType = {
	"AUDIO": 2352,
	"CDG": 2448,
	"MODE1_RAW": 2352,
	"MODE1/2048": 2048,
	"MODE1/2352": 2352,
	"MODE2_RAW": 2352,
	"MODE2/2048": 2048,		// CD-ROM Mode 2 XA form-1 data
	"MODE2/2324": 2324, 	// CD-ROM Mode 2 XA form-2 data (sector size: 2324)
	"MODE2/2336": 2336,
	"MODE2/2352": 2352,
	"CDI/2336": 2336,		// CDI Mode 2 data
	"CDI/2352": 2352		// CDI Mode 2 data
}


/**
 * Describe a .cue file
 * plus some extra functionality
 */
export class cdinfos {

	CD_ARTIST="";			// Top Level "PERFORMER" defined in the .cue fule
	CD_TITLE=""; 			// Top Level "TITLE" as defined in the .cue file
	CD_SIZE = 0;			// Bytes of all tracks that make up the CD

	CD_FILE="";				// Sanitized CD_TITLE, can be used for creating files/folders

	FILE_LOADED = null;		// FULL PATH of the cue file loaded e.g. 'c:\\games\\iso\\quake.iso'
	FILE_DIR = null;		// Shortcut for Base Directory of FILE_LOADED

	/** @type {Array.<cdtrack>} */
	tracks = [];

	// -- Helpers used by parser --
	/** @type {cdtrack} */
	opentrack = null;
	openfile = null;


	/** Prepared/Sanitized filenames for all tracks WITHOUT extension
	 * set with prepareFilenames()
	 * @type {string[]} */
	readyFiles = null;

	/**
	 * @param {String} file A valid .cue file
	 * @throws {String} Errors
	 */
	constructor(input)
	{
		if(input) this.loadCue(input);
	}

	/** Get the file associated with a track index (0 start)
	 * this could either be a shared file or a unique file
	 */
	getTrackFilePath(tr) {
		return PATH.join(this.FILE_DIR, this.tracks[tr].file ?? this.tracks[tr].shared);
	}

	/** Return the bytesize of all the audio tracks
	 */
	getAudioSize()
	{
		return this.tracks.reduce((p, c) => p + (c.isData ? 0 : c.byteSize), 0);
	}


	/**
	 * Call before building a .cue file, (for use in CBAE, one track per file)
	 * Builds the `readyFiles` variable with sanitized filenames for all tracks
	 * CBAE reads this to create the files, and then this is read to create the CUE file
	 * == Template Tags		 
	 *  {no}	;	Track Number, 01,02,03...
	 *  {cdt}	;	CD Title
	 *  {cda}	;	CD Artist
	 *  {tt}	;	Track Title
	 *  {ta}	;	Track Artist
	 * @param {String} template Custom Naming Template e.g. | "track{no}"
	 **/
	prepareFilenames(template)
	{
		this.readyFiles = [];
		
		if(!template)
		{
			// If all Tracks have TRACK TITLE
			if(this.tracks.filter(t=>t.title!=null).length == this.tracks.length)
			{
				let numartists = this.tracks.filter(t=>t.artist!=null).length;
				// If one track has an artist, print the artist on all tracks
				// Tracks that are missing artist will print a (missing)
				if(numartists > 0) {
					// "02. Clint Mansell - Leaving Earth"
					template = "{no}. {ta} - {tt}";
				}else {
					// "14. Ending Credits"
					template = "{no}. {tt}";
				}
			}else{
				// no title - no artist | The DEFAULT for most games
				// "Quake 1 - Track 01" 
				template = "{cdt} - Track {no}";
			}
		}

		for (let tr of this.tracks)
		{
			let fname = template.replace(/{(.+?)}/g, (A, B)=>{
				switch(B){
					case "cdt": return this.CD_TITLE;
					case "cda": return this.CD_ARTIST;
					case "tt": return tr.title ?? "untitled";
					case "ta": return tr.artist ?? "unknown artist";
					case "no": return tr.noStr;
					default: return B;
				}
			});

			this.readyFiles.push(sanitizePath(fname));
		}

		// Check if filenames are duplicate for some reason
		if(this.readyFiles.filter((it, ind) => this.readyFiles.indexOf(it) !== ind).length>0) {
			throw "Template resulted in duplicate entries";
		}

	}// -------------------------;


	/**
	 * Generate a new CUE file (assuming each track has its own file)
	 * - Used when converting a cue to encoded audio files
	 * - Returns data in an string array, line by line. Save it yourself.
	 * - Expects `this.readyFiles` to be set
	 * @param {String} aExt AUDIO file extension with the dot. e.g. ".opus"
	 * @returns {String[]} Generate CUE, line by line
	 * @throws {String} Errors
	 */
	buildCueFileForCBAE(aExt) {

		if(!this.readyFiles) this.prepareFilenames();

		let b = [];
		// Those are standard tags, no program should have problems parsing them
		if(this.CD_ARTIST)
		b.push(`\tPERFORMER "${this.CD_ARTIST}"`);
		b.push(`\tTITLE "${this.CD_TITLE}"`);
		b.push(``);
		
		for (let i=0;i<this.tracks.length;i++) 
		{
			let tr = this.tracks[i];
			let fn = this.readyFiles[i];

			if (tr.isData) {
				b.push(`\tFILE "${fn}.bin" BINARY`);
			} else {
				let tp = aExt.slice(1).toUpperCase();	// .mp3 -> MP3 | .ogg -> OGG
				b.push(`\tFILE "${fn}${aExt}" ${tp}`);
			}

			if(tr.title)  b.push(`\t\tTITLE "${tr.title}"`);
			if(tr.artist) b.push(`\t\tPERFORMER "${tr.artist}"`);

			b.push(`\t\tTRACK ${tr.noStr} ${tr.type}`);
			if (tr.pregap)
				b.push(`\t\tPREGAP ${tr.pregap}`);

			let i0 = tr.indexes[0].toFrames();	// Should always exist. Checked on parser

			for(let iit of tr.indexes) {
				let inew = new cuetime(iit.no,0,0,0);
					inew.fromFrames(iit.toFrames() - i0);
				b.push(`\t\tINDEX ${inew.no.toString().padStart(2,'0')} ${inew}`);
			}
		}

		return b;
	}// -------------------------------------------------------;


	/**
	 * Loads a .CUE file and fills in object fields with data
	 * @param {String} input A valid .cue file
	 * @throws {String} Errors
	 */
	loadCue(input) {
		if (this.tracks.length > 0) throw "Loading again unsupported. Make a new object";

		input = PATH.normalize(input);
		L.log(`loadCue() :: Loading "${input}"`);

		if (PATH.extname(input).toLowerCase() != ".cue") throw `Not a ".cue" file`;

		let lines = getFileLines(input);
		if(!lines) throw `Cannot load file "${input}"`;

		// -- Start Parsing the loaded CUE file
		// fills up tracks[] with data as it is read from the cue file
		for (let l = 0; l < lines.length; l++) {
			let line = lines[l].trim();
			if (line.length == 0) continue;
			try {
				this._cueParser(line);
			} catch (e) {
				throw `Cue Parse Error on Line (${l+1}) : ${e}`;
			}
		}

		this.FILE_LOADED = PATH.resolve(input);
		this.FILE_DIR = PATH.dirname(this.FILE_LOADED);

		// -- [safe checks] Post Parse 
		if (this.tracks.length == 0) throw 'No Tracks in the cue file'
		this.opentrack?.validCheck();	// The last track was not checked by the parser, check now it will throw

		// Figure out CD_TITLE by cue filename if didn't get it in CUE TITLE
		if (!this.CD_TITLE) {
			this.CD_TITLE = PATH.parse(PATH.basename(input)).name;
		}
		this.CD_FILE = sanitizePath(this.CD_TITLE); 

		// Go through tracks one more time
		//  - Find out which tracks will share track files
		//  - Check if files exist
		//  - Calculate byte positions
		for (let i = 0, ot = null, os = null; i < this.tracks.length; i++) {
			
			// ot = last track with a file
			// os = last trackfile stats

			let tr = this.tracks[i]; // shortcut
			let tr1 = this.tracks[i + 1]; // shortcut

			if (tr.file) {

				ot = tr;	// This track has a file, I need to keep it when encountering other tracks

				let f_full = PATH.join(this.FILE_DIR, ot.file);
				if (!FS.existsSync(f_full)) throw `File "${ot.file}" does not exist in .cue directory`;

				let stat = FS.statSync(f_full);
				os = stat.size;	// Open Last Size, need to have this to calculate the last track size
				this.CD_SIZE += os;

			}else
			{
				tr.shared = ot.file;
				// DEV: a FILE track will always come before a shared track
				// 		It was checked in the cue parser that the first Track always has a file
			}

			if (tr1 && !tr1.file) // If next track is shared
			{
				tr1.byteStart = sectorsByType[ot.type] * tr1.indexes[0].toFrames();
				tr.byteSize = tr1.byteStart - tr.byteStart;
			}
			else // This is the last track on the open file
			{
				tr.byteSize = os - tr.byteStart;
				// DEV: Works for both single tracks, (since bytestart=0) and
				//		last shared tracks
			}

		}// --

		// #DEBUG Infos ?  :TODO: Perhaps use  `getInfos()` to reduce redundancy
		L.log(`CD INFO | title:"${this.CD_TITLE}" size:(${this.CD_SIZE}) tracks:(${this.tracks.length})` + 
			  this.CD_ARTIST?` artist:"${this.CD_ARTIST}`:"");
		for (let t of this.tracks) L.debug(`${t}`);
		L.debug('-'.repeat(30));

	}// -------------------------;


	/** 
	* Parses CUE file lines one by one
	* Lines are trimmed
	* @param {String} line
	*/
	_cueParser(line) {
		let lineup = line.toUpperCase();

		// DEV: Checking if line starts with a string multiple times is not efficient,
		//		I could just extract the first word and then use a look-up table
		//		but then I would have to introduce more functions or a switch structure
		//		This is to be used only for small files, so it's fine

		// -- Comments
		if (lineup.startsWith('REM') || lineup.startsWith(';')) return;

		// |TITLE "Quake DOS (1996)" >> for CD title
		// - can also be TRACK titles, if read after an open track
		if (lineup.startsWith('TITLE')) {
			let res = /^\w+\s+(.+)/.exec(lineup);
			if (res == null) throw "Line error, Bad Syntax"
			// Remove first and last " if present
			res[1] = res[1].replace(/^\"(.*)\"/,"$1");

			if (this.opentrack != null)
				this.opentrack.title = res[1];
			else {
				this.CD_TITLE = res[1];
			}
			return;
		}		
		
		// - Used in audio tracks
		if (lineup.startsWith('PERFORMER')) {
			let res = /^\w+\s+(.+)/.exec(lineup);
			if (res == null) throw "Line error, Bad Syntax"
			// Remove first and last " if present
			res[1] = res[1].replace(/^\"(.*)\"/, "$1");
			if (this.opentrack != null)
				this.opentrack.artist = res[1];
			else
				this.CD_ARTIST = res[1];
			return;
		}

		// |FILE "Quake.bin" BINARY
		if (lineup.startsWith('FILE')) {
			let exp = /^\w+\s+\"(.+)\"\s+(.+)/;	// Catch : ^wwwwss"(Quake.bin)"ss(BINARY)
			let res = exp.exec(line);	// < lowercase line. I need the filename case sensitive
			if (res == null) throw "Line error, Bad Syntax"
			
			if (!SUPPORTED_TRACK_FILES.includes(res[2])) {
				throw "Unsupported TRACK File Type " + res[2];
			}

			// [Safe Check] - Check if previous track is valid -- will autothrow --
			this.opentrack?.validCheck();
			this.openfile = res[1];
			return;
		}


		// |TRACK 01 MODE1/2352
		// |TRACK 05 AUDIO
		if (lineup.startsWith('TRACK')) {
			// [Safe Check] - Make sure a FILE is declared by now
			if (this.openfile == null && this.tracks.length == 0) throw "A FILE has not been defined before TRACK 01"

			// [Safe Check] - Check if previous track is valid -- will autothrow --
			this.opentrack?.validCheck();

			let exp = /^\w+\s+(\d+)\s+(\S+)/;
			let res = exp.exec(lineup);	// < uppercase for the type, in case it was lower
			if (res == null) throw "Line error, Bad Syntax"

			// [Safe Check] - Check to see if the trackNO is already defined in the tracks
			for (let t of this.tracks) {
				if (t.no == parseInt(res[1])) {
					throw `Track ${res[1]} is already defined`;
				}
			}

			// [Safe Check] - Check if track type is valid
			if (!sectorsByType.hasOwnProperty(res[2])) {
				throw "Unsupported Track type " + res[2];
			}

			this.opentrack = new cdtrack();
			this.opentrack.no = parseInt(res[1]);
			this.opentrack.type = res[2].toUpperCase();	// uppercase just in case
			this.opentrack.file = this.openfile;	// If file was just defined, it will have a value
			this.openfile = null;
			this.tracks.push(this.opentrack);
			return;
		}

		// |INDEX 00 00:06:33
		// |INDEX 02 05:06:70
		if (lineup.startsWith('INDEX')) {
			if (this.opentrack == null) throw "A Track is not defined yet";
			let exp = /^\w+\s+(\d+)\s+(\d{1,2}):(\d{1,2}):(\d{1,2})/;	// 4 captures
			let res = exp.exec(lineup);
			if (res == null) throw "Line error, Bad Syntax"
			// [Safe Check] -- Duplicate indexes
			if (this.opentrack.indexExists(parseInt(res[1]))) {
				throw `Track ${this.opentrack.no} - Duplicate Index entry ${res[1]}`;
			}

			this.opentrack.indexes.push(
				new cuetime(
					parseInt(res[1]),
					parseInt(res[2]),
					parseInt(res[3]),
					parseInt(res[4])
				)
			);
			return;
		}

		// |PREGAP 00:00:28
		if (lineup.startsWith('PREGAP')) {
			if (this.opentrack == null) throw "A Track is not defined yet";
			let exp = /\w+\s+(\d{1,2}):(\d{1,2}):(\d{1,2})/;	// 3 captures
			let res = exp.exec(lineup);
			if (res == null) throw "Line error, Bad Syntax"
			this.opentrack.pregap = new cuetime(0,
				parseInt(res[1]),
				parseInt(res[2]),
				parseInt(res[3])
			);
			return;
		}

	}// -------------------------;

}// -- class cdinfos --


/**
 * Describe a Track on the cue File
 * Also Provides some functions
 */
class cdtrack {

	// -- The following is data that is read directly from the .cue file

	file = null;	// {String} The filename the track is associated with
	type = null;	// {String} ENUM id of the type (e.g. "mode2/2352")
	no = 0;			// {Int} Track Number 0-99

	title = null;	// {String} Track title, if defined (TITLE)
	artist = null;	// {String} Track Artist if defined (PERFORMER)

	/** @type {cuetime} */
	pregap = null;	// Pregap as defined in the cue file 

	/** @type {Array.<cuetime>} */
	indexes = [];	//  All the indexes defined in the cue file 
	/* INDEX 01 commands specify the beginning of a new track. INDEX 00 commands specify the pre-gap of a track; 
	you may notice your Audio CD player count up from a negative value before beginning a new track - this is the 
	period between INDEX 00 and INDEX 01.  */


	// -- The following is secondary helper data, not to be written to the cue file

	hash = '-';		// {String} Hash value of the track (generated interally)
	byteStart = 0;	// In case of shared file, this is where the track starts in the file
	byteSize = 0;	// In case of shared file, the length of the track from byteStart

	shared = null;	// {String} If not null, then this track shares a FILE with other tracks.
	// Filename of track as declared in cue file, same var as `file`
	// Basically Means that the file needs to be CUT to be processed
	// if <null> then this track is one file, can be copied as is

	/** Check if a particular index exists. -- for safechecks */
	indexExists(ind) {
		return this.indexes.some(a => a.no == ind);
	}

	/** Helper */
	validCheck() {
		// All tracks should have the index of 01
		if (!this.indexExists(1)) throw `TRACK ${this.no} has no INDEX`
	}

	/** Quick info of the Track */
	toString() {
		let s = this.indexes.reduce((p, c) => '' + p + ',' + c);
		return `Track #${this.no}, type:${this.type}, indexes:[${s}], b0:${this.byteStart}, b1:${this.byteSize}, file:${this.file}, hash:${this.hash}, share:${this.shared}`;
	}

	get isData() {
		return this.type != "AUDIO";
	}

	/** Return tracknumber in string XX format e.g. 01, 02 */
	get noStr() {
		return this.no.toString().padStart(2,'0');
	}

} // -------------------------------------------------------;



/**
 * Describe a TIME string that is read from a .cue file
 * Also Provides some functions
 * e.g.     INDEX 00 02:47:74
 *   		INDEX 01 02:48:27
 */
class cuetime {
	no;		// Index number
	minutes;
	seconds;
	frames;	// * there are seventy five frames to one second

	constructor(n, m, s, f) {
		this.no = n;
		this.minutes = m;
		this.seconds = s;
		this.frames = f;
	}

	toFrames() {
		return (this.seconds * 75) + (this.minutes * 60 * 75) + this.frames; z
	}

	fromFrames(f) {
		this.minutes = Math.floor(f / 4500);
		this.seconds = Math.floor((f % 4500) / 75);
		this.frames = f % 75;
	}

	toString() {
		return this.minutes.toString().padStart(2, '0') + ":" +
			this.seconds.toString().padStart(2, '0') + ":" +
			this.frames.toString().padStart(2, '0');
	}

} // -------------------------------------------------------;