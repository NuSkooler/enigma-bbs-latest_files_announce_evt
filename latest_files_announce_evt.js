/* jslint node: true */
'use strict';

//	ENiGMA½
const Message						= require('../../core/message.js');
const stringFormat					= require('../../core/string_format.js');
const persistMessage				= require('../../core/message_area.js').persistMessage;
const Config						= require('../../core/config.js').config;
const Errors						= require('../../core/enig_error.js').Errors;
const StatLog						= require('../../core/stat_log.js');
const getISOTimestampString			= require('../../core/database.js').getISOTimestampString;
const FileEntry						= require('../../core/file_entry.js');
const getSortedAvailableFileAreas	= require('../../core/file_base_area.js').getSortedAvailableFileAreas;
const AnsiPrep						= require('../../core/ansi_prep.js');
const splitTextAtTerms				= require('../../core/string_util.js').splitTextAtTerms;

//	deps
const fs				= require('graceful-fs');
const moment			= require('moment');
const async				= require('async');
const iconv				= require('iconv-lite');
const paths				= require('path');
const hjson				= require('hjson');

/*
	USAGE:

	Step 1: Create a options.hjson:

	Create a options.hjson file with any of the following keys to override
	default values (see source below for defaults):
	- areaTagsRegEx: Regex of file area tag(s) to scan
	- maxFilesPerArea: max files-per-area to list
	- header: header ASCII template filename
	- areaHeader: area header ASCII template filename
	- areaFooter: area footer ASCII template filename
	- entry: entry ASCII template filename
	- footer: final footer ASCII template filename
	- to: to name for post
	- from: from name for post
	- tsFormat: timestamp format
	- subjectFormat: subject line format
	- templateEncoding: encoding of template files (generally use utf-8)
	
	Step 2: Configure a schedule:

	Create a scheduler entry in your boards config.hjson similar to the following:
	latestFilesAnnounceEvent: {
        schedule: at 3:30 am
        action: @method:mods/latest_files_announce_evt/latest_files_announce_evt.js:latestFilesAnnounceEvent
        args: [ "fsx_bot" ]
	}

	You may list 1:n comma seperated message base area tag(s) to post to. The second parameter
	can optionally point to a full path to options.hjson file.
*/

exports.latestFilesAnnounceEvent = function latestFilesAnnounceEvent(args, cb) {

	if(args.length < 1) {
		return cb(Errors.MissingParam('At least [areaTag] required in args'));
	}

	const STAT_KEY_LAST_TS	= 'latest_files_announce_evt__last_timestamp';

	const TEMPLATE_NAMES = [
		'header', 
		'areaHeader',
		'entry',
		'areaFooter',
		'footer',
	];

	async.waterfall(
		[
			function loadOptions(callback) {
				let optionsPath;
				if(args.length > 1) {
					optionsPath = paths.isAbsolute(args[1]) ? args[1] : paths.join(__dirname, args[1]);
				} else {
					optionsPath = paths.join(__dirname, 'options.hjson');
				}

				fs.readFile(optionsPath, 'utf8', (err, optionsData) => {
					if(err && 'ENOENT' !== err.code) {	//	file not present is OK; use defaults
						return callback(err);
					}

					let options;
					if(optionsData) {
						try {
							options = hjson.parse(optionsData);
						} catch(e) {
							return callback(e);
						}
					} else {
						options = {};
					}

					options.areaTagsRegEx		= options.areaTagsRegEx || '^(?!uploads).*$';
					options.maxFilesPerArea		= options.maxFilesPerArea || 20;
					options.postMaxSizeTarget	= options.postMaxSizeTarget || 512000;	//	try for ~512k max bytes per message/post
					options.header				= options.header || 'LFASTAR.ASC';		//	main header
					options.areaHeader			= options.areaHeader || 'LFAASTAR.ASC';	//	per-area header
					options.areaFooter			= options.areaFooter || 'LFAAEND.ASC';	//	per-area footer
					options.entry				= options.entry || 'LFAENTRY.ASC';		//	entry
					options.footer				= options.footer || 'LFAEND.ASC';		//	main footer
					options.to					= options.to || 'All';
					options.from				= options.from || 'ENiGMA-Bot';
					options.tsFormat			= options.tsFormat || 'ddd, MMMM Do, YYYY';
					options.nowTs				= moment().format(options.tsFormat); 
					options.subjectFormat		= options.subjectFormat || 'New files on {boardName}';
					options.templateEncoding	= options.templateEncoding || 'utf8';

					return callback(null, options);
				});
			},
			function readTemplates(options, callback) {
				async.map( TEMPLATE_NAMES, (templateName, next) => {
					let templatePath = options[templateName];					
					templatePath = paths.isAbsolute(templatePath) ? templatePath : paths.join(__dirname, templatePath);

					fs.readFile(templatePath, (err, data) => {
						return next(err, data);
					});
				}, (err, templates) => {
					if(err) {
						return callback(Errors.General(err.message));
					}

					//	decode and ensure we have DOS style CRLF's
					templates = templates.map(tmp => iconv.decode(tmp, options.templateEncoding).replace(/\r?\n/g, '\r\n') );

					//	we assume there is only one {fileDesc}. if there are more, they won't be properly indented.
					let descIndent = 0;
					splitTextAtTerms(templates[2]).some(line => {
						const pos = line.indexOf('{fileDesc}');
						if(pos > -1) {
							descIndent = pos;
							return true;	//	found it!
						}
						return false;	//	keep looking
					});

					return callback(null, options, templates, descIndent);
				});				
			},
			function findNewFiles(options, templates, descIndent, callback) {
				const lastTimestamp = StatLog.getSystemStat(STAT_KEY_LAST_TS);

				StatLog.setSystemStat(STAT_KEY_LAST_TS, getISOTimestampString());

				if(!lastTimestamp) {
					//	we set a ts, so maybe next time...					
					return callback(Errors.General('Last timestamp not set; Set to now for next event run time'));
				}

				options.sinceTs = moment(lastTimestamp).format(options.tsFormat);

				const allAreas = getSortedAvailableFileAreas(null, { skipAcsCheck : true } ).filter(area => area.areaTag.match(options.areaTagsRegEx) );

				async.map(allAreas, (area, nextArea) => {
					FileEntry.findFiles(
						{
							newerThanTimestamp	: lastTimestamp,
							areaTag				: area.areaTag,
						},
						(err, fileIds) => {
							if(err) {
								return nextArea(err);
							}

							const remainingFiles = fileIds.length > options.maxFilesPerArea ? fileIds.length - options.maxFilesPerArea : 0;
							let areaFileBytes = 0;
							async.map(fileIds.slice(0, options.maxFilesPerArea), (fileId, nextFileId) => {
								const fileInfo = new FileEntry();
								fileInfo.load(fileId, err => {
									if(err) {
										return nextFileId(err);
									}

									areaFileBytes += fileInfo.meta.byte_size;

									//
									//	Prep description to ensure it's clean
									//
									AnsiPrep(
										fileInfo.desc,
										{
											cols			: 79 - descIndent,	//	adjusted for indentation of desc, if any
											forceLineTerm	: true,				//	ensure each line is term'd
											asciiMode		: true,				//	export to ASCII
											fillLines		: false,			//	don't fill up to |cols|
											indent			: descIndent,
										},
										(err, desc) => {
											if(desc) {
												fileInfo.desc = desc;
											}
											return nextFileId(null, fileInfo);
										}
									);
								});
							},
							(err, fileInfos) => {
								return nextArea(
									err,
									{
										areaInfo		: area,
										files			: fileInfos, 
										areaFileBytes	: areaFileBytes,
										remainingFiles	: remainingFiles,
									}
								);
							});							
						}
					);
				}, (err, allAreasFiles) => {
					return callback(err, options, templates, allAreasFiles, descIndent);
				});
			},
			function buildMessages(options, templates, allFileInfos, descIndent, callback) {
				//
				//	allFileInfos contains an array of { area : areaInfo, files : [], ... }
				//
				//	Start bulding messages attempting to keep each messages <= postMaxSizeTarget bytes.
				//
				//	Each message is:
				//	<header>
				//	<areaHeader>
				//	<entry>
				//	...
				//	<areaFooter>
				//	<footer>
				//
				//	:TODO: actually support postMaxSizeTarget
				const formatObj = {
					boardName		: Config.general.boardName,
					nowTs			: options.nowTs,
					sinceTs			: options.sinceTs,
					totalFileCount	: 0,
					totalFileBytes	: 0,
				};

				let msgBody = stringFormat(templates[0], formatObj);	//	header

				allFileInfos.forEach( areaInfo => {
					const areaFiles = areaInfo.files;

					if(0 === areaFiles.length) {
						return;
					}

					formatObj.areaFileCount			= areaFiles.length;
					formatObj.areaRemainingFiles	= areaInfo.remainingFiles;
					formatObj.areaFileBytes			= areaInfo.areaFileBytes;
					formatObj.totalFileCount		+= areaFiles.length;
					formatObj.totalFileBytes		+= areaInfo.areaFileBytes;
					formatObj.areaName				= areaInfo.areaInfo.name;
					formatObj.areaDesc				= areaInfo.areaInfo.desc;
					
					msgBody += stringFormat(templates[1], formatObj);	//	areaHeader

					areaFiles.forEach(fileInfo => {

						formatObj.fileName		= fileInfo.fileName;
						formatObj.fileSize		= fileInfo.meta.byte_size;
						formatObj.fileDesc		= fileInfo.desc || '';
						formatObj.fileSha256	= fileInfo.fileSha256;
						formatObj.fileCrc32		= fileInfo.meta.file_crc32;
						formatObj.fileMd5		= fileInfo.meta.file_md5;
						formatObj.fileSha1		= fileInfo.meta.file_sha1;
						formatObj.uploadBy		= fileInfo.meta.upload_by_username || 'N/A';

						formatObj.fileUploadTs	= fileInfo.uploadTimestamp;
						formatObj.fileHashTags	= Array.from(fileInfo.hashTags).join(', ');
						
						msgBody += stringFormat(templates[2], formatObj);	//	entry
					});

					msgBody += stringFormat(templates[3], formatObj);	//	areaFooter
				});

				msgBody += stringFormat(templates[4], formatObj);	//	footer

				if(formatObj.totalFileCount > 0) {

					const areaTags = args[0].split(',');
					return async.eachSeries(areaTags, (areaTag, next) => {
						const msg = new Message({
							areaTag			: areaTag,
							toUserName		: options.to,
							fromUserName	: options.from,
							subject			: stringFormat(options.subjectFormat, formatObj),
							message			: msgBody,
							meta			: { System : { 'explicit_encoding' : 'cp437' } },
						});
						
						return persistMessage(msg, next);
					}, err => {
						return callback(err);
					});
				}

				return callback(null);	//	no messages
			}
		],
		err => {
			return cb(err);
		}
	);	
};
