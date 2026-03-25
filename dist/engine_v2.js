(function() {
"use strict";

// =============================================================================
// MIDI FILE WRITER (Pure JS, SMF Type 1)
// =============================================================================

const TICKS_PER_BEAT = 480;
const BEATS_PER_BAR = 4;

function writeVLQ(value) {
  const bytes = [];
  bytes.push(value & 0x7F);
  value >>= 7;
  while (value > 0) {
    bytes.push((value & 0x7F) | 0x80);
    value >>= 7;
  }
  bytes.reverse();
  return bytes;
}

function writeUint16(val) { return [(val >> 8) & 0xFF, val & 0xFF]; }
function writeUint32(val) { return [(val >> 24) & 0xFF, (val >> 16) & 0xFF, (val >> 8) & 0xFF, val & 0xFF]; }
function writeString(s) { return Array.from(s).map(c => c.charCodeAt(0)); }

function buildTempoEvent(bpm) {
  const uspqn = Math.round(60000000 / bpm);
  return [0x00, 0xFF, 0x51, 0x03,
    (uspqn >> 16) & 0xFF, (uspqn >> 8) & 0xFF, uspqn & 0xFF];
}

function buildTimeSignatureEvent() {
  return [0x00, 0xFF, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08];
}

function buildProgramChange(channel, program) {
  return [0x00, 0xC0 | (channel & 0x0F), program & 0x7F];
}

function buildEndOfTrack() {
  return [0x00, 0xFF, 0x2F, 0x00];
}

function buildTrackNameEvent(name) {
  const nameBytes = writeString(name);
  return [0x00, 0xFF, 0x03, nameBytes.length, ...nameBytes];
}

function buildMarkerEvent(tick, text) {
  const textBytes = writeString(text);
  return { tick: tick, bytes: [0xFF, 0x06, textBytes.length, ...textBytes] };
}

function eventsToTrackBytes(sortedEvents, channel) {
  const msgs = [];
  for (const ev of sortedEvents) {
    if (ev.type === 'note') {
      msgs.push({ tick: ev.tick, bytes: [0x90 | (channel & 0x0F), ev.pitch & 0x7F, Math.min(127, Math.max(1, ev.velocity))] });
      msgs.push({ tick: ev.tick + ev.duration, bytes: [0x80 | (channel & 0x0F), ev.pitch & 0x7F, 0] });
    } else if (ev.type === 'cc') {
      msgs.push({ tick: ev.tick, bytes: [0xB0 | (channel & 0x0F), ev.cc & 0x7F, Math.min(127, Math.max(0, ev.value))] });
    } else if (ev.type === 'raw') {
      msgs.push({ tick: ev.tick, bytes: ev.bytes });
    }
  }
  msgs.sort((a, b) => a.tick - b.tick || a.bytes[0] - b.bytes[0]);
  const data = [];
  let prevTick = 0;
  for (const m of msgs) {
    const delta = Math.max(0, m.tick - prevTick);
    data.push(...writeVLQ(delta));
    data.push(...m.bytes);
    prevTick = m.tick;
  }
  return data;
}

function buildMidiFile(tracks, bpm, markers) {
  const allTrackChunks = [];
  const tempoEvents = [
    ...buildTrackNameEvent("Tempo"),
    ...buildTimeSignatureEvent(),
    ...buildTempoEvent(bpm)
  ];

  // Insert markers into tempo track
  if (markers && markers.length > 0) {
    // Build marker raw messages sorted by tick
    const markerMsgs = markers.map(function(m) {
      return buildMarkerEvent(m.tick, m.text);
    }).sort(function(a, b) { return a.tick - b.tick; });
    // Convert to delta-time bytes
    var prevTick = 0;
    for (var mi = 0; mi < markerMsgs.length; mi++) {
      var delta = Math.max(0, markerMsgs[mi].tick - prevTick);
      tempoEvents.push(...writeVLQ(delta));
      tempoEvents.push(...markerMsgs[mi].bytes);
      prevTick = markerMsgs[mi].tick;
    }
  }

  tempoEvents.push(...buildEndOfTrack());
  const tempoChunk = [...writeString("MTrk"), ...writeUint32(tempoEvents.length), ...tempoEvents];
  allTrackChunks.push(tempoChunk);

  for (const tr of tracks) {
    const trData = [];
    trData.push(...buildTrackNameEvent(tr.name));
    if (tr.channel !== 9 && tr.program !== undefined) {
      trData.push(...buildProgramChange(tr.channel, tr.program));
    }
    trData.push(...eventsToTrackBytes(tr.events, tr.channel));
    trData.push(...buildEndOfTrack());
    const chunk = [...writeString("MTrk"), ...writeUint32(trData.length), ...trData];
    allTrackChunks.push(chunk);
  }

  const numTracks = allTrackChunks.length;
  const header = [
    ...writeString("MThd"),
    ...writeUint32(6),
    ...writeUint16(1),
    ...writeUint16(numTracks),
    ...writeUint16(TICKS_PER_BEAT)
  ];

  const result = [...header];
  for (const ch of allTrackChunks) result.push(...ch);
  return new Uint8Array(result);
}

// =============================================================================
// CONSTANTS
// =============================================================================

const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const FLAT_NOTE_NAMES = ["C","Db","D","Eb","E","F","Gb","G","Ab","A","Bb","B"];
const FLAT_KEYS = {"F":true,"Bb":true,"Eb":true,"Ab":true,"Db":true,"Gb":true};

const KEY_ROOT = {
  "C":0,"C#":1,"Db":1,"D":2,"D#":3,"Eb":3,"E":4,
  "F":5,"F#":6,"Gb":6,"G":7,"G#":8,"Ab":8,"A":9,
  "A#":10,"Bb":10,"B":11
};

const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];

const CHORD_INTERVALS = {
  "maj7":[0,4,7,11], "min7":[0,3,7,10], "dom7":[0,4,7,10],
  "m7b5":[0,3,6,10], "dim7":[0,3,6,9], "minMaj7":[0,3,7,11],
  "min6":[0,3,7,9], "add9":[4,7,14], "sus4":[0,5,7,10],
  "maj":[0,4,7]
};

const DIATONIC_CHORDS = {
  "I": [0, "maj7"], "ii": [2, "min7"], "iii": [4, "min7"],
  "IV": [5, "maj7"], "V": [7, "dom7"], "vi": [9, "min7"],
  "vii": [11, "m7b5"]
};

const AVOID_INTERVALS = {
  "maj7": [5], "min7": [], "add9": [5], "m7b5": [],
  "dim7": [], "sus4": [], "dom7": [5],
  "min6": [], "minMaj7": [], "maj": [5]
};

const BASS_RANGE = {
  "intro": [48, 59], "verse": [48, 59], "prechorus": [48, 59],
  "chorus": [36, 47], "bridge": [48, 59], "interlude": [48, 59],
  "outro": [48, 59], "final_chorus": [36, 47]
};

const RIGHT_HAND_RANGE_BY_SECTION = {
  "intro": [60, 96], "verse": [60, 96], "prechorus": [60, 96],
  "chorus": [48, 84], "bridge": [60, 96], "interlude": [60, 96],
  "outro": [60, 96], "final_chorus": [48, 84]
};

const RIGHT_HAND_RANGE = [48, 84];

const DEFAULT_SECTION_BARS = {
  "intro": 4, "verse": 8, "prechorus": 4, "chorus": 8,
  "bridge": 4, "interlude": 4, "outro": 4, "final_chorus": 8
};

const SECTION_DYNAMICS = {
  "intro": 3, "verse": 4, "prechorus": 6, "chorus": 8,
  "bridge": 4, "interlude": 2, "outro": 3, "final_chorus": 10
};

const HUMANIZE_SETTINGS = {
  "intro": {quantize:88, velocity_var:5, timing_var_ms:12},
  "verse": {quantize:85, velocity_var:5, timing_var_ms:15},
  "prechorus": {quantize:90, velocity_var:4, timing_var_ms:10},
  "chorus": {quantize:95, velocity_var:3, timing_var_ms:6},
  "bridge": {quantize:85, velocity_var:5, timing_var_ms:12},
  "interlude": {quantize:80, velocity_var:7, timing_var_ms:20},
  "outro": {quantize:82, velocity_var:6, timing_var_ms:18},
  "final_chorus": {quantize:95, velocity_var:3, timing_var_ms:6}
};

const ARPEGGIO_PATTERNS = {
  "ascending": [[0,0.0,0.9],[7,0.5,0.7],[12,1.0,0.75],[14,1.5,0.65],[16,2.0,0.8]],
  "descending": [[16,0.0,0.85],[14,0.5,0.7],[12,1.0,0.75],[7,1.5,0.65],[0,2.0,0.9]],
  "waltz": [[0,0.0,0.9],[7,0.5,0.6],[12,1.0,0.7],[0,1.5,0.85],[7,2.0,0.6],[12,2.5,0.7],[0,3.0,0.8]],
  "broken": [[0,0.0,0.9],[12,0.5,0.7],[7,1.0,0.75],[14,1.5,0.65],[0,2.0,0.85],[16,2.5,0.7]],
  "alberti": [[7,0.0,0.7],[0,0.25,0.9],[12,0.5,0.65],[0,0.75,0.85],[7,1.0,0.7],[0,1.25,0.9],[12,1.5,0.65],[0,1.75,0.85],[7,2.0,0.7],[0,2.25,0.9],[12,2.5,0.65],[0,2.75,0.85]],
  "simple": [[0,0.0,0.85],[7,1.0,0.65],[12,2.0,0.7]]
};

const SECTION_ARPEGGIO_STYLE = {
  "intro":"simple","verse":"ascending","prechorus":"broken",
  "chorus":"alberti","bridge":"waltz","interlude":"simple",
  "outro":"descending","final_chorus":"alberti"
};

function getVelocityFromDynamics(dynamicLevel) {
  dynamicLevel = Math.max(1, Math.min(10, dynamicLevel));
  var baseVelocity = 35 + (dynamicLevel - 1) * 8;
  var v = 4;
  function clampVel(x) { return Math.max(1, Math.min(127, x)); }
  return {
    bass: [clampVel(baseVelocity - v), clampVel(baseVelocity + v)],
    inner: [clampVel(baseVelocity - v - 15), clampVel(baseVelocity + v - 15)],
    top: [clampVel(baseVelocity - v + 8), clampVel(baseVelocity + v + 8)]
  };
}

var SECTION_VELOCITY = {};
for (var sk in SECTION_DYNAMICS) {
  SECTION_VELOCITY[sk] = getVelocityFromDynamics(SECTION_DYNAMICS[sk]);
}

const LOW_INTERVAL_LIMIT = 52;

// =============================================================================
// UTILITY
// =============================================================================

function rand(a, b) { return Math.floor(Math.random() * (b - a + 1)) + a; }
function randFloat(a, b) { return Math.random() * (b - a) + a; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function getBaseSectionType(name) {
  var n = (name || "").toLowerCase().replace(/[\s\-]/g, "");
  if (n.indexOf("final") >= 0 && n.indexOf("chorus") >= 0) return "final_chorus";
  if (n.indexOf("pre") >= 0 && n.indexOf("chorus") >= 0) return "prechorus";
  if (n.indexOf("chorus") >= 0) return "chorus";
  if (n.indexOf("interlude") >= 0) return "interlude";
  if (n.indexOf("verse") >= 0) return "verse";
  if (n.indexOf("intro") >= 0) return "intro";
  if (n.indexOf("bridge") >= 0) return "bridge";
  if (n.indexOf("outro") >= 0) return "outro";
  return "verse";
}

function parseRomanToChord(roman, key) {
  var keyRoot = KEY_ROOT[key] || 0;
  var chordMap = {
    "I":[0,"maj7"],"I7":[0,"dom7"],"ii":[2,"min7"],"iii":[4,"min7"],"IV":[5,"maj7"],
    "V":[7,"dom7"],"Vadd9":[7,"add9"],"vi":[9,"min7"],"vii":[11,"m7b5"],
    "vm7":[7,"min7"],
    "iv":[5,"min7"],"iv6":[5,"min6"],"bVI":[8,"maj7"],"bVII":[10,"maj7"],
    "#IVdim7":[6,"dim7"],"bIIIdim7":[3,"dim7"],"Vsus4":[7,"sus4"],
    "#IV7#11":[6,"dom7"]
  };

  if (roman === "IV/V") {
    return { root:(keyRoot+5)%12, type:"maj", slash_bass:(keyRoot+7)%12, hybrid:true, roman:roman };
  }

  if (roman.indexOf("/") >= 0) {
    var parts = roman.split("/");
    var base = parts[0], bassPart = parts[1];
    if (base === "V" && chordMap[bassPart]) {
      var targetInterval = chordMap[bassPart][0];
      return { root:(keyRoot+targetInterval+7)%12, type:"dom7", slash_bass:null, hybrid:false, roman:roman };
    }
    if (/^[0-9B]$/.test(bassPart)) {
      if (chordMap[base]) {
        var interval = chordMap[base][0], chordType = chordMap[base][1];
        var root = (keyRoot + interval) % 12;
        var bassNote = root;
        if (bassPart === "3") bassNote = (root + 4) % 12;
        else if (bassPart === "5") bassNote = (root + 7) % 12;
        else if (bassPart === "B") bassNote = (root + 11) % 12;
        return { root:root, type:chordType, slash_bass:bassNote, hybrid:false, roman:roman };
      }
    }
  }

  if (chordMap[roman]) {
    var ci = chordMap[roman];
    return { root:(keyRoot+ci[0])%12, type:ci[1], slash_bass:null, hybrid:false, roman:roman };
  }

  return { root:keyRoot, type:"maj7", slash_bass:null, hybrid:false, roman:roman };
}

function isValidSlashChord(chordRoot, slashBass, chordType) {
  if (slashBass === null || slashBass === undefined) return true;
  var interval = ((slashBass - chordRoot) % 12 + 12) % 12;
  if (interval === 1) return false;
  if (interval === 8 && chordType !== "maj7") return false;
  var validMap = {
    "maj7":[0,4,7,11,2,5,9],"min7":[0,3,7,10,2,5,9],"dom7":[0,4,7,10,2,5,9],
    "add9":[0,4,7,2,5,9],"sus4":[0,5,7,10,2,9],"dim7":[0,3,6,9],
    "m7b5":[0,3,6,10],"maj":[0,4,7,2,5,9]
  };
  var valid = validMap[chordType] || [0,4,7,11];
  return valid.indexOf(interval) >= 0;
}

// =============================================================================
// SECTION PATTERNS (K-Ballad)
// =============================================================================

var SectionPatterns = {
  INTRO_VERSE: [
    ["I","V/3","vi","iii","IV","I/3","ii","V"],
    ["I","ii","iii","IV","I/3","ii","V","I"],
    ["I","iii","vi","IV","I/3","ii","Vsus4","V"]
  ],
  PRECHORUS: [
    ["IV","V","iii","vi","IV","I/3","ii","V"],
    ["IV","V","I","I","vi","IV","Vsus4","V"],
    ["IV","V","IV/3","V/3","I","V/3","vi","V"]
  ],
  CHORUS: [
    ["IV","V","iii","vi","ii","V","I","I"],
    ["I","IV","V","V/iii","vi","I/5","IV","V/ii","iii","vi","ii","Vsus4","V"],
    ["I","V","vi","iii","IV","I","ii","V"],
    ["I","iii","IV","iv6","iii","vi","ii","V"]
  ],
  BRIDGE: [
    ["vi","iii","IV","V","vi","V/ii","ii","V"],
    ["IV","iv","iii","V/vi","ii","V","Vsus4","V"]
  ],
  INTERLUDE: [
    ["I","V/3","vi","IV","I","V/3","vi","IV"],
    ["vi","IV","I","V","vi","IV","ii","V"],
    ["I","IV","vi","V"]
  ],
  OUTRO: [
    ["I","V/3","vi","IV","I","V/3","vi","IV"],
    ["IV","V","I","I","IV","V","I","I"]
  ]
};

// =============================================================================
// CHORD PROGRESSION GENERATOR
// =============================================================================

function ChordProgressionGenerator(key) {
  this.key = key;
  this.keyRoot = KEY_ROOT[key] || 0;
  this._patternCache = {};
}

ChordProgressionGenerator.prototype._getBaseType = function(sectionType) {
  var s = (sectionType || "").toLowerCase().replace(/[\s\-]/g, "");
  if (s.indexOf("intro") >= 0) return "intro";
  if (s.indexOf("interlude") >= 0) return "interlude";
  if (s.indexOf("verse") >= 0) return "verse";
  if (s.indexOf("prechorus") >= 0 || s.indexOf("pre") >= 0) return "prechorus";
  if (s.indexOf("chorus") >= 0) return "chorus";
  if (s.indexOf("bridge") >= 0) return "bridge";
  if (s.indexOf("outro") >= 0) return "outro";
  return "verse";
};

ChordProgressionGenerator.prototype._getPatternsForSection = function(baseType) {
  if (baseType === "intro" || baseType === "verse") return SectionPatterns.INTRO_VERSE;
  if (baseType === "prechorus") return SectionPatterns.PRECHORUS;
  if (baseType === "chorus") return SectionPatterns.CHORUS;
  if (baseType === "bridge") return SectionPatterns.BRIDGE;
  if (baseType === "interlude") return SectionPatterns.INTERLUDE;
  if (baseType === "outro") return SectionPatterns.OUTRO;
  return SectionPatterns.INTRO_VERSE;
};

ChordProgressionGenerator.prototype.getSectionPattern = function(sectionType) {
  var baseType = this._getBaseType(sectionType);
  if (!this._patternCache[baseType]) {
    var patterns = this._getPatternsForSection(baseType);
    this._patternCache[baseType] = patterns[rand(0, patterns.length - 1)];
  }
  return this._patternCache[baseType];
};

ChordProgressionGenerator.prototype._parseChord = function(roman) {
  var result = parseRomanToChord(roman, this.key);
  result.roman = roman;
  return result;
};

ChordProgressionGenerator.prototype.generateProgression = function(sectionType, bars) {
  var pattern = this.getSectionPattern(sectionType);
  var progression = [];
  for (var bar = 0; bar < bars; bar++) {
    var chordIdx = bar % pattern.length;
    var roman = pattern[chordIdx];
    var chordInfo = this._parseChord(roman);
    chordInfo.bar = bar;
    chordInfo.beat = 0;
    chordInfo.duration = 4;
    progression.push(chordInfo);
  }
  progression = this._applySecondaryDominants(progression);
  progression = this._applyModalInterchange(progression);
  progression = this._applyMinorV(progression);
  progression = this._applyDiminishedPassing(progression);
  progression = this._applySus4Resolution(progression);
  progression = this._applyV7Alternatives(progression);
  progression = this._ensureDominantEnding(progression);
  progression = this._preventChordRepetition(progression);
  progression = this._validateSlashChords(progression);
  return progression;
};

ChordProgressionGenerator.prototype._applySecondaryDominants = function(prog) {
  var self = this;
  var result = [];
  for (var i = 0; i < prog.length; i++) {
    var chord = prog[i];
    if (chord.roman === "vi" && Math.random() < 0.2) {
      if (result.length > 0 && result[result.length-1].roman !== "V/vi" && result[result.length-1].roman !== "iii") {
        result[result.length-1].duration = 2;
        var secondary = {
          roman:"V/vi", root:(self.keyRoot+4)%12, type:"dom7",
          slash_bass:null, bar:chord.bar, beat:2, duration:2
        };
        result.push(secondary);
        chord.beat = 0;
        chord.duration = 4;
      }
    }
    result.push(chord);
  }
  return result;
};

ChordProgressionGenerator.prototype._applyModalInterchange = function(prog) {
  for (var i = 0; i < prog.length; i++) {
    if (prog[i].roman === "IV") {
      if (i + 1 < prog.length && (prog[i+1].roman === "V" || prog[i+1].roman === "Vsus4")) {
        if (Math.random() < 0.15) {
          prog[i].roman = "iv";
          prog[i].type = "min7";
        }
      }
    }
  }
  return prog;
};

// Minor v substitution: V → vm7 (borrowed from parallel minor)
// vm7 resolves to I or I7, providing modal color without dominant tension.
// Low probability (~12%). Occasionally uses #IV7#11 (Lydian dominant) instead (~3%).
ChordProgressionGenerator.prototype._applyMinorV = function(prog) {
  // vm7 is ALWAYS half-bar (2 beats), followed by I7 or #IV7#11 (also 2 beats)
  // Splits any eligible chord into: [original(2)] [vm7(2)] then next bar becomes [I7 or #IV7#11(2)] [original next(2)]
  // Eligible: any chord with duration 4 that is NOT the last chord, and not Vsus4
  var self = this;
  var result = [];
  var applied = false;

  for (var i = 0; i < prog.length; i++) {
    var chord = prog[i];
    var next = i + 1 < prog.length ? prog[i + 1] : null;

    if (!applied && next && chord.duration === 4 && next.duration === 4) {
      // Skip Vsus4 and secondary dominants
      if (chord.roman === "Vsus4" || chord.roman.indexOf("V/") === 0) {
        result.push(chord);
        continue;
      }
      // Skip if next is already vm7/I7
      if (next.roman === "vm7" || next.roman === "I7" || next.roman === "#IV7#11") {
        result.push(chord);
        continue;
      }

      if (Math.random() < 0.25) {
        // vm7 always on beat 0 (downbeat): vm7(beat0,2) + I7/#IV7#11(beat2,2) replaces current chord
        var vm = {
          roman: "vm7", root: (self.keyRoot + 7) % 12, type: "min7",
          slash_bass: null, hybrid: false,
          bar: chord.bar, beat: chord.beat || 0, duration: 2
        };
        result.push(vm);

        var resolveRoman, resolveRoot;
        if (Math.random() < 0.85) {
          resolveRoman = "I7";
          resolveRoot = self.keyRoot;
        } else {
          resolveRoman = "#IV7#11";
          resolveRoot = (self.keyRoot + 6) % 12;
        }
        var resolve = {
          roman: resolveRoman, root: resolveRoot, type: "dom7",
          slash_bass: null, hybrid: false,
          bar: chord.bar, beat: (chord.beat || 0) + 2, duration: 2
        };
        result.push(resolve);

        // current chord is replaced, next chord stays untouched
        applied = true;
        continue;
      }
    }

    result.push(chord);
  }
  return result;
};

ChordProgressionGenerator.prototype._applyDiminishedPassing = function(prog) {
  var self = this;
  var result = [];
  var cases = [
    [["IV","iv"], "#IVdim7", 6, ["V","Vsus4","Vadd9","IV/V"]],
    [["I","I/3","I/5"], "bIIIdim7", 3, ["ii","iii"]]
  ];
  for (var i = 0; i < prog.length; i++) {
    var chord = prog[i];
    var prevChord = result.length > 0 ? result[result.length - 1] : null;
    if (prevChord === null) { result.push(chord); continue; }
    var inserted = false;
    for (var c = 0; c < cases.length; c++) {
      var prevRomans = cases[c][0], dimRoman = cases[c][1], dimRootInterval = cases[c][2], nextRomans = cases[c][3];
      if (prevRomans.indexOf(prevChord.roman) >= 0 && nextRomans.indexOf(chord.roman) >= 0) {
        var prevBass = prevChord.slash_bass !== null && prevChord.slash_bass !== undefined ? prevChord.slash_bass : prevChord.root;
        var currBass = chord.slash_bass !== null && chord.slash_bass !== undefined ? chord.slash_bass : chord.root;
        var dimBass = (self.keyRoot + dimRootInterval) % 12;
        var prevToDim = ((dimBass - prevBass) % 12 + 12) % 12;
        var dimToCurr = ((currBass - dimBass) % 12 + 12) % 12;
        if (prevToDim === 1 && dimToCurr === 1 && Math.random() < 0.10) {
          // Diminished as passing: split previous bar — dim occupies only the last beat
          // Previous chord takes beats 0-2, dim takes beat 2-4 (half bar each)
          result[result.length-1].duration = 2;
          result[result.length-1].beat = prevChord.beat || 0;
          var dimChord = {
            roman:dimRoman, root:(self.keyRoot+dimRootInterval)%12, type:"dim7",
            slash_bass:null, bar:prevChord.bar, beat:(prevChord.beat||0)+2, duration:2
          };
          result.push(dimChord);
          inserted = true;
          break;
        }
      }
    }
    result.push(chord);
  }
  return result;
};

ChordProgressionGenerator.prototype._applySus4Resolution = function(prog) {
  var result = [];
  for (var i = 0; i < prog.length; i++) {
    var chord = prog[i];
    if (chord.roman === "V" && chord.duration >= 4) {
      var sus4 = {
        roman:"Vsus4", root:chord.root, type:"sus4",
        slash_bass:null, bar:chord.bar, beat:0, duration:2
      };
      result.push(sus4);
      chord.beat = 2;
      chord.duration = 2;
    }
    result.push(chord);
  }
  return result;
};

ChordProgressionGenerator.prototype._applyV7Alternatives = function(prog) {
  var self = this;
  for (var i = 0; i < prog.length; i++) {
    var chord = prog[i];
    var isVChord = chord.type === "dom7" && (chord.roman === "V" || chord.roman.indexOf("V/") === 0);
    var isSecondary = chord.roman === "V/vi" || chord.roman === "V/ii" || chord.roman === "V/iii";
    if (isVChord && !isSecondary) {
      var prevIsIV = (i > 0 && (prog[i-1].roman === "IV" || prog[i-1].roman === "iv" || prog[i-1].roman === "#IVdim7"));
      if (prevIsIV && chord.roman === "V") {
        if (Math.random() < 0.4) {
          chord.roman = "IV/V";
          chord.root = (self.keyRoot + 5) % 12;
          chord.type = "maj";
          chord.slash_bass = (self.keyRoot + 7) % 12;
          chord.hybrid = true;
        } else {
          chord.roman = "Vadd9";
          chord.type = "add9";
        }
      } else {
        if (chord.roman.indexOf("V/") === 0 && chord.roman !== "V/vi") {
          var bp = chord.roman.split("/")[1];
          chord.roman = "Vadd9/" + bp;
        } else {
          chord.roman = "Vadd9";
        }
        chord.type = "add9";
      }
    }
  }
  return prog;
};

ChordProgressionGenerator.prototype._ensureDominantEnding = function(prog) {
  if (!prog.length) return prog;
  var self = this;
  var last = prog[prog.length - 1];
  var dominantRomans = ["V","Vadd9","Vsus4","IV/V","V/vi","V/ii"];
  if (dominantRomans.indexOf(last.roman) >= 0) return prog;

  // Replace last chord with V
  var newChord = self._parseChord("V");
  newChord.bar = last.bar;
  newChord.beat = last.beat || 0;
  newChord.duration = last.duration || 4;
  prog[prog.length - 1] = newChord;

  // Fix pre-dominant context for functional harmony
  // Goal: ...→ [pre-dominant] → V should make harmonic sense
  // Valid pre-dominant chords: ii, IV, iv, vi, I/5 (all naturally lead to V)
  // Invalid before V: iii, I, vii (weak or no dominant preparation)
  if (prog.length >= 2) {
    var secondLast = prog[prog.length - 2];
    var secondBase = secondLast.roman.indexOf("/") >= 0 ? secondLast.roman.split("/")[0] : secondLast.roman;
    var validPreDominant = ["ii","IV","iv","iv6","vi","bVI","bVII","I7","vm7"];
    if (validPreDominant.indexOf(secondBase) < 0) {
      // Pick a functional pre-dominant: ii (most common), IV, vi
      var preDomOptions = ["ii","IV","vi","IV"];
      var pick = preDomOptions[Math.floor(Math.random() * preDomOptions.length)];
      var pdChord = self._parseChord(pick);
      pdChord.bar = secondLast.bar;
      pdChord.beat = secondLast.beat || 0;
      pdChord.duration = secondLast.duration || 4;
      prog[prog.length - 2] = pdChord;
    }
  }

  // Also check 3rd-to-last for smoother approach
  if (prog.length >= 3) {
    var thirdLast = prog[prog.length - 3];
    var thirdBase = thirdLast.roman.indexOf("/") >= 0 ? thirdLast.roman.split("/")[0] : thirdLast.roman;
    var secondBase2 = prog[prog.length - 2].roman.indexOf("/") >= 0 ? prog[prog.length - 2].roman.split("/")[0] : prog[prog.length - 2].roman;
    // If 3rd-to-last is same function as 2nd-to-last, substitute for variety
    if (thirdBase === secondBase2) {
      var altMap = {"ii":"vi","IV":"ii","vi":"IV"};
      var alt = altMap[thirdBase];
      if (alt) {
        var altChord = self._parseChord(alt);
        altChord.bar = thirdLast.bar;
        altChord.beat = thirdLast.beat || 0;
        altChord.duration = thirdLast.duration || 4;
        prog[prog.length - 3] = altChord;
      }
    }
  }
  return prog;
};

ChordProgressionGenerator.prototype._preventChordRepetition = function(prog) {
  if (prog.length < 2) return prog;
  var self = this;
  var result = [prog[0]];
  var substituteMap = {
    "I":["I/3","I/5","iii"],"ii":["ii/3","IV"],"iii":["iii/5","I/3"],
    "IV":["IV/5","ii"],"V":["Vsus4","V/3"],"Vadd9":["IV/V","V/3"],
    "vi":["vi/3","iii","IV"]
  };
  for (var i = 1; i < prog.length; i++) {
    var curr = prog[i], prev = result[result.length - 1];
    var isSus4Res = prev.roman === "Vsus4" && (curr.roman === "V" || curr.roman === "Vadd9") && prev.root === curr.root;
    var isSame = prev.root === curr.root && prev.type === curr.type && prev.roman === curr.roman;
    if (isSame && !isSus4Res) {
      var baseRoman = curr.roman.indexOf("/") >= 0 ? curr.roman.split("/")[0] : curr.roman;
      var subs = substituteMap[baseRoman];
      if (subs && subs.length > 0) {
        var newChord = self._parseChord(subs[0]);
        newChord.bar = curr.bar;
        newChord.beat = curr.beat || 0;
        newChord.duration = curr.duration || 4;
        result.push(newChord);
      } else {
        result.push(curr);
      }
    } else {
      result.push(curr);
    }
  }
  return result;
};

ChordProgressionGenerator.prototype._validateSlashChords = function(prog) {
  var self = this;
  var result = [];
  for (var i = 0; i < prog.length; i++) {
    var chord = prog[i];
    if (chord.slash_bass !== null && chord.slash_bass !== undefined) {
      if (!isValidSlashChord(chord.root, chord.slash_bass, chord.type)) {
        chord.slash_bass = null;
      }
    }
    result.push(chord);
  }
  return result;
};

// =============================================================================
// VOICING GENERATOR
// =============================================================================

function VoicingGenerator(keyRoot) {
  this.keyRoot = keyRoot || 0;
  this.prevTopNote = null;
  this.prevBassNote = null;
  this.prevChordRoot = null;
  this.prevChordType = null;
  this.prevRoman = null;
  this.currentSectionType = "verse";
}

VoicingGenerator.prototype.reset = function() {
  this.prevTopNote = null;
  this.prevBassNote = null;
};

// ── Dynamic Case: 보이싱 룰 Dy1~Dy4 ──
VoicingGenerator.prototype._getDynamicCase = function(level) {
  level = Math.max(1, Math.min(10, level));
  if (level <= 3) {
    // Dy1: 인트로/인털루드 앞부분. bass≥C3, top≤C5, vel 48-55
    return { dyCase:1, bassMin:48, bassMax:59, topMax:72, velAvg:48+(level-1)*5, velRange:7, rhOffset:0 };
  } else if (level <= 5) {
    // Dy2: 벌스. bass≥C2(가급적), top≤C4, vel 44-50, RH -5
    return { dyCase:2, bassMin:36, bassMax:52, topMax:60, velAvg:44+(level-3)*5, velRange:8, rhOffset:-5 };
  } else if (level <= 7) {
    // Dy3: 프리코러스. Dy2 음역 + vel+7
    return { dyCase:3, bassMin:36, bassMax:52, topMax:60, velAvg:51+7+(level-5)*5, velRange:8, rhOffset:-5 };
  } else {
    // Dy4: 코러스/하이라이트. 확장 음역, vel 70-80
    return { dyCase:4, bassMin:29, bassMax:52, topMax:67, velAvg:70+(level-7)*5, velRange:10, rhOffset:0 };
  }
};

VoicingGenerator.prototype._getSectionDynamic = function(sectionType, isFinalChorus) {
  if (isFinalChorus) return SECTION_DYNAMICS["final_chorus"] || 10;
  var bt = (sectionType || "").toLowerCase().replace(/[\s\-]/g, "");
  for (var k in SECTION_DYNAMICS) { if (bt.indexOf(k) >= 0) return SECTION_DYNAMICS[k]; }
  return SECTION_DYNAMICS["verse"] || 4;
};

VoicingGenerator.prototype.generateVoicing = function(chord, sectionType, isFinalChorus, customDynamic, barIndex) {
  var root = chord.root;
  var chordType = chord.type;
  this.currentSectionType = sectionType;

  var dynLevel = customDynamic || this._getSectionDynamic(sectionType, isFinalChorus);
  var dyCase = this._getDynamicCase(dynLevel);

  var bassRange = [dyCase.bassMin, dyCase.bassMax];
  var bass = this._generateBass(root, bassRange, chord.slash_bass);
  var leftHandExtension = this._generateLeftHand(bass, root, chordType, dyCase, barIndex);
  var rightHand = this._generateRightHand(root, chordType, dyCase);
  rightHand = this._enforceLowIntervalLimit(rightHand);
  // topMax 초과 음은 옥타브 내림
  var topMax = dyCase.topMax;
  for (var ti = 0; ti < rightHand.length; ti++) {
    while (rightHand[ti] > topMax && rightHand[ti] - 12 >= 36) rightHand[ti] -= 12;
  }
  rightHand.sort(function(a,b){return a-b;});

  var allLeft = [bass].concat(leftHandExtension);
  var velocities = this._calculateVelocities(allLeft, rightHand, dyCase);

  // 왼손/오른손 중복 제거
  var allLeftSet = {};
  allLeft.forEach(function(n) { allLeftSet[n] = true; });
  var rhFiltered = [];
  for (var i = 0; i < rightHand.length; i++) {
    if (!allLeftSet[rightHand[i]]) rhFiltered.push(rightHand[i]);
  }
  var rhSet = {};
  rhFiltered.forEach(function(n) { rhSet[n] = true; });
  var lhFiltered = [];
  for (var i = 0; i < leftHandExtension.length; i++) {
    if (!rhSet[leftHandExtension[i]]) lhFiltered.push(leftHandExtension[i]);
  }

  var allNotes = [bass].concat(lhFiltered).concat(rhFiltered).sort(function(a,b){return a-b;});

  this.prevBassNote = bass;
  this.prevChordRoot = root;
  this.prevChordType = chordType;
  this.prevRoman = chord.roman || "";
  if (rhFiltered.length > 0) this.prevTopNote = Math.max.apply(null, rhFiltered);

  return {
    bass: bass,
    left_hand: lhFiltered,
    right_hand: rhFiltered,
    velocities: velocities,
    all_notes: allNotes
  };
};

// ── 왼손: 기본 bass+5th, Dy4는 bass+옥타브+더블링 ──
VoicingGenerator.prototype._generateLeftHand = function(bass, _root, _chordType, dyCase, barIndex) {
  var extension = [];
  if (dyCase.dyCase === 4) {
    // Dy4: 5도 대신 옥타브
    var octNote = bass + 12;
    if (octNote <= dyCase.topMax) extension.push(octNote);
    // 4배수 마디 첫 코드에서 베이스 더블링 (-1 옥타브)
    if (barIndex !== undefined && barIndex % 4 === 0) {
      var doubleBass = bass - 12;
      if (doubleBass >= 24) extension.unshift(doubleBass);
    }
  } else {
    // Dy1~3: bass + 5th (5th가 오른손 최저음보다 높으면 생략 — topMax로 근사)
    var fifthNote = bass + 7;
    if (fifthNote > LOW_INTERVAL_LIMIT) extension.push(fifthNote);
  }
  return extension;
};

VoicingGenerator.prototype._generateBass = function(root, bassRange, slashBass) {
  var minB = bassRange[0], maxB = bassRange[1];
  var targetPC = (slashBass !== null && slashBass !== undefined) ? slashBass : root;
  var candidates = [];
  for (var oct = 1; oct < 6; oct++) {
    var note = targetPC + oct * 12;
    if (note >= minB && note <= maxB) candidates.push(note);
  }
  if (candidates.length === 0) {
    var baseNote = minB + ((targetPC - minB % 12) % 12 + 12) % 12;
    if (baseNote < minB) baseNote += 12;
    candidates = (baseNote <= maxB) ? [baseNote] : [minB];
  }
  if (this.prevBassNote !== null && candidates.length > 1) {
    var prev = this.prevBassNote;
    candidates.sort(function(a, b) { return Math.abs(a - prev) - Math.abs(b - prev); });
    var close = candidates.filter(function(n) { return Math.abs(n - prev) <= 7; });
    if (close.length > 0) return close[0];
    return candidates[0];
  }
  return candidates[0] || minB;
};

// ── A폼/B폼 오른손 보이싱 ──
VoicingGenerator.prototype._generateRightHand = function(root, chordType, dyCase) {
  // A폼: 7,9,3,5 순 (아래→위)
  var A_FORM = {
    "maj7":[11,14,16,19], "min7":[10,14,15,19], "dom7":[10,14,16,19],
    "sus4":[10,14,17,19], "dim7":[9,15,18], "m7b5":[10,14,15,18],
    "min6":[3,7,9], "add9":[11,14,16,19], "maj":[7,12,16], "minMaj7":[11,14,15,19]
  };
  // B폼: 3,5,7,9 순 (아래→위)
  var B_FORM = {
    "maj7":[4,7,11,14], "min7":[3,7,10,14], "dom7":[4,7,10,14],
    "sus4":[5,7,10,14], "dim7":[3,6,9], "m7b5":[3,6,10,14],
    "min6":[3,7,9], "add9":[4,7,11,14], "maj":[4,7,12], "minMaj7":[3,7,11,14]
  };

  var aIntervals = (A_FORM[chordType] || A_FORM["maj7"]).slice();
  var bIntervals = (B_FORM[chordType] || B_FORM["maj7"]).slice();

  // baseOctave: 오른손 기준 옥타브 — Dy에 따라 조절
  // Dy1: C3(48) — 넉넉한 음역. Dy2/Dy3: C2(36) — topMax=60. Dy4: C2(36)
  var baseOctave = (dyCase.dyCase === 1) ? 48 : 36;

  var aNotes = aIntervals.map(function(iv) { return root + iv + baseOctave; });
  var bNotes = bIntervals.map(function(iv) { return root + iv + baseOctave; });

  var aTop = Math.max.apply(null, aNotes);
  var bTop = Math.max.apply(null, bNotes);
  var topMax = dyCase.topMax;

  var chosenNotes;

  if (this.prevTopNote === null) {
    // 첫 코드: 음역 내에서 랜덤
    var aOk = aTop <= topMax;
    var bOk = bTop <= topMax;
    if (aOk && bOk) chosenNotes = Math.random() < 0.5 ? aNotes : bNotes;
    else if (aOk) chosenNotes = aNotes;
    else if (bOk) chosenNotes = bNotes;
    else chosenNotes = (aTop <= bTop) ? aNotes : bNotes; // 둘 다 초과 시 낮은 쪽
  } else {
    var aDiff = Math.abs(aTop - this.prevTopNote);
    var bDiff = Math.abs(bTop - this.prevTopNote);

    // 5도(7반음) 이상 차이나면 음역 우선 → 랜덤
    if (aDiff >= 7 && bDiff >= 7) {
      var aOk = aTop <= topMax;
      var bOk = bTop <= topMax;
      if (aOk && bOk) chosenNotes = Math.random() < 0.5 ? aNotes : bNotes;
      else if (aOk) chosenNotes = aNotes;
      else if (bOk) chosenNotes = bNotes;
      else chosenNotes = (aTop <= bTop) ? aNotes : bNotes;
    } else {
      // 이전 탑노트에 더 가까운 폼 선택
      var preferred = (aDiff <= bDiff) ? aNotes : bNotes;
      var prefTop = (aDiff <= bDiff) ? aTop : bTop;
      var other = (aDiff <= bDiff) ? bNotes : aNotes;

      if (prefTop <= topMax) {
        chosenNotes = preferred;
      } else {
        // 선택된 폼이 음역 초과 → 다른 폼
        chosenNotes = other;
      }
    }
  }

  // 루트 제거 + 중복 제거
  var rootPC = root % 12;
  var finalNotes = [];
  for (var i = 0; i < chosenNotes.length; i++) {
    var note = chosenNotes[i];
    if (note % 12 !== rootPC && finalNotes.indexOf(note) < 0) {
      finalNotes.push(note);
    }
  }

  return finalNotes.sort(function(a,b) { return a - b; });
};

VoicingGenerator.prototype._enforceLowIntervalLimit = function(notes) {
  if (notes.length < 2) return notes;
  var result = notes.slice().sort(function(a,b){return a-b;});
  var fixed = [];
  for (var i = 0; i < result.length; i++) {
    var note = result[i];
    if (note <= LOW_INTERVAL_LIMIT && fixed.length > 0) {
      var prevNote = fixed[fixed.length - 1];
      var iv = note - prevNote;
      if ((iv === 3 || iv === 4 || iv === 5) && prevNote <= LOW_INTERVAL_LIMIT) {
        note += 12;
      }
    }
    fixed.push(note);
  }
  return fixed.sort(function(a,b){return a-b;});
};

// ── Dy 기반 벨로시티 ──
VoicingGenerator.prototype._calculateVelocities = function(leftHand, rightHand, dyCase) {
  var velocities = {};
  var avg = dyCase.velAvg;
  var range = dyCase.velRange;
  var rhOff = dyCase.rhOffset;

  // 왼손
  if (leftHand.length > 0) {
    var bassVel = clamp(rand(avg - range, avg + range), 30, 127);
    velocities[leftHand[0]] = bassVel;
    for (var i = 1; i < leftHand.length; i++) {
      velocities[leftHand[i]] = clamp(Math.floor(bassVel * 0.8), 30, 127);
    }
  }

  // 오른손
  if (rightHand.length > 0) {
    var rhAvg = avg + rhOff;
    for (var i = 0; i < rightHand.length; i++) {
      velocities[rightHand[i]] = clamp(rand(rhAvg - range, rhAvg + range), 30, 127);
    }
  }

  return velocities;
};

// =============================================================================
// DRUM GENERATOR
// =============================================================================

var DN = {
  KICK:36, SNARE:38, RIMSHOT:37, SIDE_STICK:37,
  CLOSED_HIHAT:42, OPEN_HIHAT:46, PEDAL_HIHAT:44,
  RIDE:51, RIDE_BELL:53, CRASH:49, CRASH_2:57,
  TOM_HIGH:50, TOM_MID:47, TOM_LOW:45, TOM_FLOOR:43,
  TAMBOURINE:54, SHAKER:70, COWBELL:56, CLAP:39
};

var SECTION_DRUM_CONFIG = {
  "intro":{enabled:false,style:"none",percussion:"none"},
  "verse":{enabled:false,style:"none",percussion:"none"},
  "verse_2":{enabled:true,style:"verse_light",percussion:"tambourine_4th"},
  "prechorus":{enabled:true,style:"prechorus_hihat",percussion:"tambourine_8th"},
  "chorus":{enabled:true,style:"full",percussion:"tambourine_8th"},
  "bridge":{enabled:true,style:"bridge_halftime",percussion:"shaker_8th"},
  "interlude":{enabled:false,style:"none",percussion:"none"},
  "final_chorus":{enabled:true,style:"full_crash",percussion:"tambourine_8th"},
  "outro":{enabled:true,style:"fadeout",percussion:"shaker_8th"}
};

var STYLE_VELOCITY = {
  "none":{kick:[0,0],snare:[0,0],hihat:[0,0],crash:[0,0],tambourine:[0,0],shaker:[0,0]},
  "verse_light":{kick:[75,90],snare:[0,0],hihat:[55,70],crash:[0,0],tambourine:[45,60],shaker:[40,55]},
  "minimal":{kick:[0,0],snare:[0,0],hihat:[55,68],ride:[60,72],tambourine:[0,0],shaker:[40,55]},
  "buildup":{kick:[70,85],snare:[0,0],hihat:[58,72],crash:[0,0],tambourine:[50,65],shaker:[45,60]},
  "prechorus_hihat":{kick:[65,80],snare:[60,75],hihat:[60,75],crash:[0,0],tambourine:[55,70],shaker:[50,65]},
  "prechorus_buildup":{kick:[70,85],snare:[70,85],hihat:[65,80],crash:[0,0],tambourine:[60,75],shaker:[55,70]},
  "prechorus_4th":{kick:[0,0],snare:[0,0],hihat:[55,70],crash:[0,0],tambourine:[50,65],shaker:[45,60]},
  "bridge_halftime":{kick:[70,85],snare:[75,90],hihat:[0,0],ride:[55,70],crash:[0,0],tambourine:[0,0],shaker:[45,60]},
  "full":{kick:[95,110],snare:[98,112],hihat:[65,80],crash:[100,115],tambourine:[60,75],shaker:[55,70]},
  "full_crash":{kick:[100,115],snare:[102,118],hihat:[68,85],crash:[105,120],tambourine:[65,80],shaker:[60,75]},
  "fadeout":{kick:[0,0],snare:[0,0],hihat:[0,0],ride:[50,62],tambourine:[0,0],shaker:[40,55]}
};

// Pattern definitions (beat_offset, note, velocity_ratio)
var DP = {};
DP.HIHAT_8TH = [[0.0,DN.CLOSED_HIHAT,0.85],[0.5,DN.CLOSED_HIHAT,0.55],[1.0,DN.CLOSED_HIHAT,0.75],[1.5,DN.CLOSED_HIHAT,0.50],[2.0,DN.CLOSED_HIHAT,0.80],[2.5,DN.CLOSED_HIHAT,0.55],[3.0,DN.CLOSED_HIHAT,0.75],[3.5,DN.CLOSED_HIHAT,0.50]];
DP.PRECHORUS_HIHAT_8TH = [[0.0,DN.CLOSED_HIHAT,0.80],[0.5,DN.CLOSED_HIHAT,0.55],[1.0,DN.CLOSED_HIHAT,0.70],[1.5,DN.CLOSED_HIHAT,0.50],[2.0,DN.CLOSED_HIHAT,0.75],[2.5,DN.CLOSED_HIHAT,0.55],[3.0,DN.CLOSED_HIHAT,0.70],[3.5,DN.CLOSED_HIHAT,0.55]];
DP.HIHAT_4TH = [[0.0,DN.CLOSED_HIHAT,0.80],[1.0,DN.CLOSED_HIHAT,0.65],[2.0,DN.CLOSED_HIHAT,0.75],[3.0,DN.CLOSED_HIHAT,0.65]];

DP.KICK_STABLE = [[0.0,DN.KICK,1.0],[2.0,DN.KICK,0.9]];
DP.KICK_BALLAD = [[0.0,DN.KICK,1.0],[1.5,DN.KICK,0.75],[2.0,DN.KICK,0.85]];
DP.KICK_RELAXED = [[0.0,DN.KICK,1.0],[3.0,DN.KICK,0.85]];
DP.KICK_BUILDUP = [[0.0,DN.KICK,0.75],[2.0,DN.KICK,0.70]];

DP.SNARE_BASIC = [[1.0,DN.SNARE,1.0],[3.0,DN.SNARE,0.95]];
DP.SNARE_WITH_GHOST = [[1.0,DN.SNARE,1.0],[1.5,DN.SNARE,0.08],[2.5,DN.SNARE,0.08],[3.0,DN.SNARE,0.95],[3.5,DN.SNARE,0.08]];
DP.SNARE_CHORUS = [[1.0,DN.SNARE,1.0],[1.5,DN.SNARE,0.08],[2.5,DN.SNARE,0.08],[3.0,DN.SNARE,0.95]];

DP.FULL_STABLE = DP.KICK_STABLE.concat(DP.SNARE_CHORUS).concat(DP.HIHAT_8TH);
DP.FULL_BALLAD = DP.KICK_BALLAD.concat(DP.SNARE_CHORUS).concat(DP.HIHAT_8TH);
DP.FULL_WITH_GHOST = DP.KICK_BALLAD.concat(DP.SNARE_WITH_GHOST).concat(DP.HIHAT_8TH);
DP.VERSE_LIGHT = DP.KICK_BALLAD.concat(DP.HIHAT_4TH);
DP.VERSE_LIGHT_STABLE = DP.KICK_STABLE.concat(DP.HIHAT_4TH);

DP.MINIMAL_RIDE = [[0.0,DN.RIDE,0.75],[0.5,DN.RIDE,0.50],[1.0,DN.RIDE,0.65],[1.5,DN.RIDE,0.45],[2.0,DN.RIDE,0.70],[2.5,DN.RIDE,0.50],[3.0,DN.RIDE,0.65],[3.5,DN.RIDE,0.45]];
DP.BRIDGE_HALFTIME = [[0.0,DN.KICK,0.85],[0.0,DN.RIDE,0.70],[0.5,DN.RIDE,0.45],[1.0,DN.RIDE,0.60],[1.5,DN.RIDE,0.40],[2.0,DN.SNARE,0.90],[2.0,DN.RIDE,0.65],[2.5,DN.RIDE,0.45],[3.0,DN.RIDE,0.60],[3.5,DN.RIDE,0.40]];
DP.BRIDGE_HALFTIME_SIMPLE = [[0.0,DN.KICK,0.80],[0.0,DN.RIDE,0.70],[0.5,DN.RIDE,0.45],[1.0,DN.RIDE,0.60],[1.5,DN.RIDE,0.40],[2.0,DN.RIDE,0.65],[2.5,DN.RIDE,0.45],[3.0,DN.RIDE,0.60],[3.5,DN.RIDE,0.40]];

DP.BUILDUP_BASIC = DP.KICK_BUILDUP.concat(DP.HIHAT_8TH);
DP.BUILDUP_INTENSE = DP.KICK_STABLE.concat(DP.SNARE_BASIC).concat(DP.HIHAT_8TH);

DP.PRECHORUS_BUILDUP_1 = DP.PRECHORUS_HIHAT_8TH;
DP.PRECHORUS_BUILDUP_2 = [[0.0,DN.KICK,0.7],[2.0,DN.KICK,0.65]].concat(DP.PRECHORUS_HIHAT_8TH);
DP.PRECHORUS_BUILDUP_3 = [[0.0,DN.KICK,0.8],[1.0,DN.SNARE,0.6],[2.0,DN.KICK,0.75],[3.0,DN.SNARE,0.55]].concat(DP.PRECHORUS_HIHAT_8TH);
DP.PRECHORUS_BUILDUP_4 = [[0.0,DN.KICK,0.95],[1.0,DN.SNARE,0.85],[1.5,DN.KICK,0.7],[2.0,DN.KICK,0.9],[3.0,DN.SNARE,0.9]].concat(DP.PRECHORUS_HIHAT_8TH);

DP.FADEOUT = [[0.0,DN.RIDE,0.55],[2.0,DN.RIDE,0.45]];
DP.CRASH_ACCENT = [[0.0,DN.CRASH,1.0]];

// Percussion patterns
DP.TAMBOURINE_8TH = [[0.0,DN.TAMBOURINE,0.7],[0.5,DN.TAMBOURINE,0.5],[1.0,DN.TAMBOURINE,0.65],[1.5,DN.TAMBOURINE,0.45],[2.0,DN.TAMBOURINE,0.7],[2.5,DN.TAMBOURINE,0.5],[3.0,DN.TAMBOURINE,0.65],[3.5,DN.TAMBOURINE,0.45]];
DP.TAMBOURINE_4TH = [[0.0,DN.TAMBOURINE,0.65],[1.0,DN.TAMBOURINE,0.55],[2.0,DN.TAMBOURINE,0.65],[3.0,DN.TAMBOURINE,0.55]];
DP.SHAKER_8TH = [[0.0,DN.SHAKER,0.55],[0.5,DN.SHAKER,0.4],[1.0,DN.SHAKER,0.55],[1.5,DN.SHAKER,0.4],[2.0,DN.SHAKER,0.55],[2.5,DN.SHAKER,0.4],[3.0,DN.SHAKER,0.55],[3.5,DN.SHAKER,0.4]];
DP.SHAKER_16TH = [[0.0,DN.SHAKER,0.6],[0.25,DN.SHAKER,0.4],[0.5,DN.SHAKER,0.55],[0.75,DN.SHAKER,0.35],[1.0,DN.SHAKER,0.6],[1.25,DN.SHAKER,0.4],[1.5,DN.SHAKER,0.55],[1.75,DN.SHAKER,0.35],[2.0,DN.SHAKER,0.6],[2.25,DN.SHAKER,0.4],[2.5,DN.SHAKER,0.55],[2.75,DN.SHAKER,0.35],[3.0,DN.SHAKER,0.6],[3.25,DN.SHAKER,0.4],[3.5,DN.SHAKER,0.55],[3.75,DN.SHAKER,0.35]];

// Fill patterns
DP.FILL_01 = [[0.0,DN.TOM_HIGH,1.0],[1.0,DN.TOM_LOW,1.0],[2.0,DN.KICK,1.0],[2.0,DN.CRASH,1.0]];
DP.FILL_02 = [[1.0,DN.SNARE,0.90],[2.0,DN.SNARE,1.0],[2.5,DN.KICK,1.0],[2.5,DN.CRASH,1.0]];
DP.FILL_03 = [[0.0,DN.KICK,1.0],[1.0,DN.SNARE,1.0],[2.0,DN.KICK,1.0],[2.0,DN.CRASH,1.0]];
DP.FILL_04 = [[0.0,DN.OPEN_HIHAT,1.0],[2.0,DN.KICK,1.0],[2.0,DN.CRASH,1.0]];
DP.FILL_05 = [[0.0,DN.TOM_HIGH,1.0],[1.0,DN.TOM_FLOOR,1.0],[2.0,DN.KICK,1.0],[2.0,DN.CRASH,1.0]];
DP.FILL_06 = [[1.5,DN.SNARE,1.0],[2.0,DN.KICK,1.0]];
DP.FILL_07 = [[0.0,DN.TOM_FLOOR,1.0],[1.0,DN.TOM_FLOOR,1.0],[2.0,DN.KICK,1.0],[2.0,DN.CRASH,1.0]];
DP.FILL_08 = [[0.0,DN.TOM_HIGH,1.0],[1.0,DN.TOM_LOW,1.0],[2.0,DN.CRASH,1.0],[2.0,DN.CRASH_2,1.0],[2.0,DN.KICK,1.0]];
DP.FILL_09 = [[0.0,DN.TOM_HIGH,1.0],[0.25,DN.TOM_HIGH,0.9],[0.5,DN.TOM_MID,0.95],[0.75,DN.TOM_MID,0.85],[1.0,DN.TOM_LOW,0.9],[1.25,DN.TOM_LOW,0.8],[1.5,DN.TOM_FLOOR,0.85],[1.75,DN.TOM_FLOOR,0.75],[2.0,DN.KICK,1.0],[2.0,DN.CRASH,1.0]];
DP.FILL_10 = [[0.0,DN.SNARE,0.7],[0.25,DN.SNARE,0.75],[0.5,DN.SNARE,0.8],[0.75,DN.SNARE,0.85],[1.0,DN.SNARE,0.9],[1.25,DN.SNARE,0.92],[1.5,DN.SNARE,0.95],[1.75,DN.SNARE,1.0],[2.0,DN.KICK,1.0],[2.0,DN.CRASH,1.0]];
DP.FILL_11 = [[1.5,DN.RIMSHOT,0.6],[2.0,DN.KICK,0.8]];
DP.FILL_12 = [[0.0,DN.KICK,1.0],[0.5,DN.SNARE,0.9],[0.75,DN.TOM_HIGH,0.85],[1.0,DN.TOM_MID,0.9],[1.25,DN.SNARE,0.85],[1.5,DN.TOM_LOW,0.9],[1.75,DN.KICK,0.8],[2.0,DN.CRASH,1.0],[2.0,DN.KICK,1.0]];
DP.FILL_13 = [[0.0,DN.CLOSED_HIHAT,0.7],[0.25,DN.CLOSED_HIHAT,0.75],[0.5,DN.CLOSED_HIHAT,0.8],[0.75,DN.CLOSED_HIHAT,0.85],[1.0,DN.SNARE,0.85],[1.25,DN.SNARE,0.9],[1.5,DN.SNARE,0.95],[1.75,DN.SNARE,1.0],[2.0,DN.KICK,1.0],[2.0,DN.CRASH,1.0]];
DP.FILL_14 = [[0.0,DN.CRASH,0.9],[1.0,DN.TOM_HIGH,0.85],[1.5,DN.TOM_LOW,0.9],[2.0,DN.KICK,1.0],[2.0,DN.CRASH,1.0]];
DP.FILL_15 = [[0.0,DN.RIMSHOT,0.5],[0.5,DN.RIMSHOT,0.55],[1.0,DN.RIMSHOT,0.6],[1.5,DN.SNARE,0.7],[2.0,DN.KICK,0.85]];
DP.FILL_16 = [[0.0,DN.KICK,1.0],[0.25,DN.KICK,0.9],[0.5,DN.SNARE,0.95],[1.0,DN.KICK,0.95],[1.25,DN.KICK,0.85],[1.5,DN.SNARE,1.0],[2.0,DN.KICK,1.0],[2.0,DN.CRASH,1.0],[2.0,DN.CRASH_2,0.9]];

DP.FILL_SET = [DP.FILL_01,DP.FILL_02,DP.FILL_03,DP.FILL_04,DP.FILL_05,DP.FILL_06,DP.FILL_07,DP.FILL_08,DP.FILL_09,DP.FILL_10,DP.FILL_11,DP.FILL_12,DP.FILL_13,DP.FILL_14,DP.FILL_15,DP.FILL_16];

DP.SECTION_FILL_MAP = {
  "prechorus":[DP.FILL_13,DP.FILL_10,DP.FILL_02],
  "chorus":[DP.FILL_03,DP.FILL_01,DP.FILL_05,DP.FILL_12],
  "final_chorus":[DP.FILL_09,DP.FILL_16,DP.FILL_08],
  "bridge":[DP.FILL_11,DP.FILL_15,DP.FILL_06],
  "verse_2":[DP.FILL_11,DP.FILL_15,DP.FILL_06],
  "outro":[DP.FILL_11,DP.FILL_15]
};

function DrumGenerator() {
  this.verseCount = 0;
  this.prechorusCount = 0;
}

DrumGenerator.prototype._getSectionType = function(name) {
  var n = (name || "").toLowerCase().replace(/[\s\-]/g, "");
  if (n.indexOf("final") >= 0 && n.indexOf("chorus") >= 0) return "final_chorus";
  if (n.indexOf("pre") >= 0 && n.indexOf("chorus") >= 0) return "prechorus";
  if (n.indexOf("chorus") >= 0) return "chorus";
  if (n.indexOf("verse") >= 0) {
    if (n.indexOf("2") >= 0 || n.indexOf("ii") >= 0) return "verse_2";
    return "verse";
  }
  if (n.indexOf("intro") >= 0) return "intro";
  if (n.indexOf("bridge") >= 0) return "bridge";
  if (n.indexOf("interlude") >= 0) return "interlude";
  if (n.indexOf("outro") >= 0) return "outro";
  return "verse";
};

DrumGenerator.prototype._getPatternForStyle = function(style, barInSection, totalBars) {
  if (style === "none") return [];
  if (style === "verse_light") return barInSection % 2 === 0 ? DP.VERSE_LIGHT : DP.VERSE_LIGHT_STABLE;
  if (style === "minimal") return DP.MINIMAL_RIDE;
  if (style === "prechorus_hihat") {
    if (this.prechorusCount === 1) {
      if (barInSection === 0) return DP.PRECHORUS_BUILDUP_1;
      if (barInSection === 1) return DP.PRECHORUS_BUILDUP_2;
      if (barInSection === 2) return DP.PRECHORUS_BUILDUP_3;
      return DP.PRECHORUS_BUILDUP_4;
    } else {
      if (barInSection < Math.floor(totalBars / 2)) return DP.PRECHORUS_BUILDUP_3;
      return DP.PRECHORUS_BUILDUP_4;
    }
  }
  if (style === "bridge_halftime") return barInSection % 2 === 0 ? DP.BRIDGE_HALFTIME : DP.BRIDGE_HALFTIME_SIMPLE;
  if (style === "buildup") {
    var progress = barInSection / Math.max(totalBars - 1, 1);
    return progress < 0.5 ? DP.BUILDUP_BASIC : DP.BUILDUP_INTENSE;
  }
  if (style === "full") {
    var pi = barInSection % 3;
    if (pi === 0) return DP.FULL_BALLAD;
    if (pi === 1) return DP.FULL_STABLE;
    return DP.FULL_WITH_GHOST;
  }
  if (style === "full_crash") {
    var pi = barInSection % 3;
    var base;
    if (pi === 0) base = DP.FULL_BALLAD;
    else if (pi === 1) base = DP.FULL_STABLE;
    else base = DP.FULL_WITH_GHOST;
    if (barInSection === 0 || (barInSection === 4 && totalBars >= 8)) return base.concat(DP.CRASH_ACCENT);
    return base;
  }
  if (style === "fadeout") return DP.FADEOUT;
  return [];
};

DrumGenerator.prototype._getPercussionPattern = function(percStyle) {
  if (!percStyle || percStyle === "none") return [];
  if (percStyle === "tambourine_8th") return DP.TAMBOURINE_8TH;
  if (percStyle === "tambourine_4th") return DP.TAMBOURINE_4TH;
  if (percStyle === "shaker_16th") return DP.SHAKER_16TH;
  if (percStyle === "shaker_8th") return DP.SHAKER_8TH;
  return [];
};

DrumGenerator.prototype._getFill = function(sectionType, barInSection, totalBars) {
  if (barInSection !== totalBars - 1) return [[], 0.0];
  var sectionFills = DP.SECTION_FILL_MAP[sectionType];
  var fill;
  if (sectionFills) fill = sectionFills[rand(0, sectionFills.length - 1)];
  else fill = DP.FILL_SET[rand(0, DP.FILL_SET.length - 1)];
  return [fill, 1.0];
};

DrumGenerator.prototype._calcVelocity = function(note, velRatio, velConfig) {
  var velRange;
  if (note === DN.KICK) velRange = velConfig.kick || [70,85];
  else if (note === DN.SNARE) velRange = velConfig.snare || [75,90];
  else if (note === DN.CLOSED_HIHAT || note === DN.OPEN_HIHAT) velRange = velConfig.hihat || [55,70];
  else if (note === DN.RIDE) velRange = velConfig.ride || [50,65];
  else if (note === DN.CRASH || note === DN.CRASH_2) velRange = velConfig.crash || [85,100];
  else if (note === DN.TOM_HIGH || note === DN.TOM_MID || note === DN.TOM_LOW || note === DN.TOM_FLOOR) velRange = velConfig.snare || [75,90];
  else if (note === DN.TAMBOURINE) velRange = velConfig.tambourine || [50,65];
  else if (note === DN.SHAKER) velRange = velConfig.shaker || [45,60];
  else velRange = [60,75];
  if (velRange[0] === 0 && velRange[1] === 0) return 0;
  var baseVel = rand(velRange[0], velRange[1]);
  return clamp(Math.floor(baseVel * velRatio), 1, 127);
};

DrumGenerator.prototype._getNoteDuration = function(note) {
  if (note === DN.CRASH) return 2.0;
  if (note === DN.RIDE) return 0.4;
  if (note === DN.TOM_HIGH || note === DN.TOM_MID || note === DN.TOM_LOW || note === DN.TOM_FLOOR) return 0.3;
  return 0.2;
};

DrumGenerator.prototype._addGhostNotes = function(fillStartBeat, usedBeats) {
  var ghosts = [];
  for (var i = 0; i < 12; i++) {
    var pos = i * 0.25;
    if (usedBeats[pos]) continue;
    if (pos % 0.5 === 0) continue;
    var ghostInstr = Math.random() < 0.6 ? DN.RIMSHOT : DN.SNARE;
    var tv = randFloat(-0.005, 0.005);
    ghosts.push([ghostInstr, fillStartBeat + pos + tv, 0.1, 10]);
  }
  return ghosts;
};

DrumGenerator.prototype.generateDrumTrack = function(previewData, bpm, sectionSettings) {
  this.verseCount = 0;
  this.prechorusCount = 0;
  var allNotes = [];
  var currentBeat = 0;

  for (var si = 0; si < previewData.length; si++) {
    var section = previewData[si];
    var sectionName = section.section;
    var bars = section.bars;
    var sectionType = this._getSectionType(sectionName);
    var isRepeat = section.repeat || false;
    var repeatCount = section.repeatCount || (isRepeat ? 2 : 1);

    var secSettings = sectionSettings ? (sectionSettings[sectionName] || {}) : {};
    var drumEnabled = secSettings.drum;

    if (sectionType === "prechorus") this.prechorusCount++;
    else if (sectionType === "verse" || sectionType === "verse_2") this.verseCount++;

    var style, percussionStyle;
    if (drumEnabled === undefined || drumEnabled === null) {
      var config = SECTION_DRUM_CONFIG[sectionType] || SECTION_DRUM_CONFIG["verse"];
      drumEnabled = config.enabled;
      style = config.style;
      percussionStyle = config.percussion || "none";
    } else {
      if (drumEnabled) {
        var config = SECTION_DRUM_CONFIG[sectionType] || SECTION_DRUM_CONFIG["verse"];
        style = config.style !== "none" ? config.style : "full";
        percussionStyle = config.percussion || "none";
      } else {
        style = "none";
        percussionStyle = "none";
      }
    }

    for (var ri = 0; ri < repeatCount; ri++) {
      for (var bar = 0; bar < bars; bar++) {
        if (!drumEnabled) continue;
        var barStart = currentBeat + bar * 4;
        var pattern = this._getPatternForStyle(style, bar, bars);
        var fillResult = this._getFill(sectionType, bar, bars);
        var fillPattern = fillResult[0], fillOffset = fillResult[1];
        var velConfig = STYLE_VELOCITY[style] || STYLE_VELOCITY["full"];

        // Main pattern
        for (var p = 0; p < pattern.length; p++) {
          var beatOff = pattern[p][0], note = pattern[p][1], velR = pattern[p][2];
          if (fillPattern.length > 0 && beatOff >= fillOffset) continue;
          var vel = this._calcVelocity(note, velR, velConfig);
          if (vel === 0) continue;
          var tv = randFloat(-0.008, 0.008);
          var dur = this._getNoteDuration(note);
          allNotes.push([note, barStart + beatOff + tv, dur, vel]);
        }

        // Percussion
        var percPattern = this._getPercussionPattern(percussionStyle);
        if (percPattern.length > 0) {
          var snareMainBeats = {};
          for (var p = 0; p < pattern.length; p++) {
            if (pattern[p][1] === DN.SNARE && pattern[p][2] >= 0.5) snareMainBeats[pattern[p][0]] = true;
          }
          var hihatBeats = {};
          for (var p = 0; p < pattern.length; p++) {
            if (pattern[p][1] === DN.CLOSED_HIHAT || pattern[p][1] === DN.OPEN_HIHAT || pattern[p][1] === DN.PEDAL_HIHAT) hihatBeats[pattern[p][0]] = true;
          }
          for (var pp = 0; pp < percPattern.length; pp++) {
            var pBeat = percPattern[pp][0], pNote = percPattern[pp][1], pVR = percPattern[pp][2];
            if (fillPattern.length > 0 && pBeat >= fillOffset) continue;
            if (pNote === DN.TAMBOURINE) {
              if (!snareMainBeats[pBeat]) continue;
              if (hihatBeats[pBeat]) continue;
            }
            var pVel = this._calcVelocity(pNote, pVR, velConfig);
            if (pVel === 0) continue;
            var ptv = randFloat(-0.005, 0.005);
            allNotes.push([pNote, barStart + pBeat + ptv, 0.15, pVel]);
          }
        }

        // Fill
        if (fillPattern.length > 0) {
          var fillUsedBeats = {};
          for (var fp = 0; fp < fillPattern.length; fp++) {
            var fBeat = fillPattern[fp][0], fNote = fillPattern[fp][1], fVR = fillPattern[fp][2];
            var fVel = this._calcVelocity(fNote, fVR, velConfig);
            if (fVel === 0) continue;
            var fDur = this._getNoteDuration(fNote);
            allNotes.push([fNote, barStart + fillOffset + fBeat, fDur, fVel]);
            fillUsedBeats[fBeat] = true;
          }
          var ghosts = this._addGhostNotes(barStart + fillOffset, fillUsedBeats);
          for (var g = 0; g < ghosts.length; g++) allNotes.push(ghosts[g]);
        }
      }
      currentBeat += bars * 4;
    }
  }
  return allNotes;
};

// =============================================================================
// BASS GENERATOR
// =============================================================================

var BASS_RANGE_BASS = {
  "intro":[40,52],"verse":[40,52],"verse_2":[40,52],"prechorus":[36,48],
  "chorus":[28,40],"final_chorus":[28,40],"bridge":[40,52],
  "interlude":[40,52],"outro":[36,48]
};
var BASS_VELOCITY_BASS = {
  "intro":[38,50],"verse":[60,75],"verse_2":[65,80],"prechorus":[70,85],
  "chorus":[95,110],"final_chorus":[105,120],"bridge":[55,70],
  "interlude":[35,48],"outro":[50,65]
};
var BASS_ENABLED = {
  "intro":false,"verse":false,"verse_2":true,"prechorus":true,
  "chorus":true,"final_chorus":true,"bridge":true,"interlude":false,"outro":true
};
var KICK_PATTERNS = {
  "intro":[],"verse":[0.0,1.5,2.0],"verse_2":[0.0,1.5,2.0],
  "prechorus":[0.0,2.0],"chorus":[0.0,1.5,2.0],"final_chorus":[0.0,1.5,2.0],
  "bridge":[0.0],"interlude":[],"outro":[0.0,2.0]
};

function BassGenerator() {
  this.prevBassNote = null;
  this.keyRoot = 0;
}

BassGenerator.prototype.setKey = function(key) {
  this.keyRoot = KEY_ROOT[key] || 0;
};

BassGenerator.prototype.reset = function() {
  this.prevBassNote = null;
};

BassGenerator.prototype._getSectionType = function(name) {
  var n = (name || "").toLowerCase().replace(/[\s\-]/g, "");
  if (n.indexOf("final") >= 0 && n.indexOf("chorus") >= 0) return "final_chorus";
  if (n.indexOf("pre") >= 0 && n.indexOf("chorus") >= 0) return "prechorus";
  if (n.indexOf("chorus") >= 0) return "chorus";
  if (n.indexOf("verse") >= 0) {
    if (n.indexOf("2") >= 0 || n.indexOf("ii") >= 0) return "verse_2";
    return "verse";
  }
  if (n.indexOf("intro") >= 0) return "intro";
  if (n.indexOf("bridge") >= 0) return "bridge";
  if (n.indexOf("interlude") >= 0) return "interlude";
  if (n.indexOf("outro") >= 0) return "outro";
  return "verse";
};

BassGenerator.prototype._getRootFromRoman = function(roman) {
  if (roman.indexOf("/") >= 0) {
    var parts = roman.split("/");
    var base = parts[0].trim(), bassPart = parts[1].trim();
    var secondaryTargets = ["ii","iii","iv","vi","II","III","IV","VI"];
    if (base.toUpperCase() === "V" && secondaryTargets.indexOf(bassPart) >= 0) {
      var targetRoot = this._getChordRoot(bassPart);
      return (targetRoot + 7) % 12;
    }
    if (/^\d$/.test(bassPart) || bassPart === "3" || bassPart === "5" || bassPart === "7") {
      return (this._getChordRoot(base) + this._getInterval(bassPart)) % 12;
    }
    return this._getChordRoot(bassPart);
  }
  return this._getChordRoot(roman);
};

BassGenerator.prototype._getChordRoot = function(roman) {
  var rc = roman.replace(/add9|sus4|7|maj|m7b5|dim/g, "").trim();
  var dm = {
    "I":0,"i":0,"II":2,"ii":2,"#II":3,"bII":1,
    "III":4,"iii":4,"bIII":3,"IV":5,"iv":5,"#IV":6,
    "V":7,"v":7,"bV":6,"VI":9,"vi":9,"bVI":8,
    "VII":11,"vii":11,"bVII":10
  };
  return dm[rc] || 0;
};

BassGenerator.prototype._getInterval = function(s) {
  var m = {"3":4,"b3":3,"5":7,"7":11,"b7":10};
  return m[s] || 0;
};

BassGenerator.prototype._findClosestBassNote = function(rootPC, sectionType) {
  var range = BASS_RANGE_BASS[sectionType] || BASS_RANGE_BASS["verse"];
  var low = range[0], high = range[1];
  var candidates = [];
  for (var oct = 0; oct < 10; oct++) {
    var note = rootPC + oct * 12;
    if (note >= low && note <= high) candidates.push(note);
  }
  if (candidates.length === 0) {
    candidates = [rootPC + Math.floor(low / 12) * 12];
  }
  if (this.prevBassNote === null) return candidates[Math.floor(candidates.length / 2)];
  var prev = this.prevBassNote;
  candidates.sort(function(a, b) { return Math.abs(a - prev) - Math.abs(b - prev); });
  var close = candidates.filter(function(n) { return Math.abs(n - prev) <= 7; });
  return close.length > 0 ? close[0] : candidates[0];
};

BassGenerator.prototype.generateBassTrack = function(previewData, key, bpm, sectionSettings) {
  this.setKey(key);
  this.reset();
  var allNotes = [];
  var currentBar = 0;

  for (var si = 0; si < previewData.length; si++) {
    var section = previewData[si];
    var sectionName = section.section;
    var sectionType = this._getSectionType(sectionName);
    var chords = section.chords || [];
    var totalBars = section.bars;
    var isRepeat = section.repeat || false;
    var repeatCount = section.repeatCount || (isRepeat ? 2 : 1);

    var secSettings = sectionSettings ? (sectionSettings[sectionName] || {}) : {};
    var dynamic = secSettings.dynamic || 5;

    var globalBassEnabled = sectionSettings ? (sectionSettings._bass_enabled !== false) : true;
    if (!globalBassEnabled) { currentBar += totalBars * repeatCount; continue; }

    for (var ri = 0; ri < repeatCount; ri++) {
      var chordsByBar = {};
      for (var ci = 0; ci < chords.length; ci++) {
        var bn = chords[ci].bar !== undefined ? chords[ci].bar : ci;
        if (chordsByBar[bn] === undefined) chordsByBar[bn] = chords[ci];
      }

      for (var barInSection = 0; barInSection < totalBars; barInSection++) {
        var chord = chordsByBar[barInSection];
        if (!chord) {
          for (var pb = barInSection - 1; pb >= 0; pb--) {
            if (chordsByBar[pb]) { chord = chordsByBar[pb]; break; }
          }
          if (!chord) chord = {roman:"I", bar:barInSection};
        }

        if (chord._skip) { currentBar++; continue; }
        if (!BASS_ENABLED[sectionType]) { currentBar++; continue; }

        var roman = chord.roman || "I";
        var rootRelative = this._getRootFromRoman(roman);
        var rootPC = (this.keyRoot + rootRelative) % 12;
        var bassNote = this._findClosestBassNote(rootPC, sectionType);
        var kickPattern = KICK_PATTERNS[sectionType] || [0.0, 2.0];
        if (kickPattern.length === 0) { currentBar++; continue; }

        var velRange = BASS_VELOCITY_BASS[sectionType] || BASS_VELOCITY_BASS["verse"];
        var dynamicFactor = (dynamic - 5) / 5;
        var baseVel = rand(velRange[0], velRange[1]);
        var velocity = clamp(Math.floor(baseVel * (1 + dynamicFactor * 0.25)), 40, 127);

        var isFillBar = barInSection === totalBars - 1;
        var maxBeat = isFillBar ? 2.5 : 4.0;

        for (var ki = 0; ki < kickPattern.length; ki++) {
          var kickBeat = kickPattern[ki];
          if (kickBeat >= maxBeat) continue;
          var dur;
          if (ki + 1 < kickPattern.length) {
            var nextKick = kickPattern[ki + 1];
            dur = (nextKick >= maxBeat) ? maxBeat - kickBeat - 0.05 : nextKick - kickBeat - 0.05;
          } else {
            dur = maxBeat - kickBeat - 0.05;
          }
          dur = Math.max(0.3, dur);
          var tv = randFloat(-0.012, 0.012);
          var vv = rand(-4, 4);
          allNotes.push([bassNote, currentBar * 4 + kickBeat + tv, dur, clamp(velocity + vv, 40, 127)]);
        }
        this.prevBassNote = bassNote;
        currentBar++;
      }
    }
  }
  return allNotes;
};

// =============================================================================
// STRINGS GENERATOR
// =============================================================================

var STRING_RANGES = {
  "violin_1":[60,84],"violin_2":[60,84],"viola":[48,72],"cello":[36,60]
};

var SECTION_STRING_CONFIG = {
  "intro":{violin_1:"none",violin_2:"none",viola:"none",cello:"none"},
  "verse":{violin_1:"none",violin_2:"none",viola:"none",cello:"none"},
  "verse_2":{violin_1:"none",violin_2:"none",viola:"none",cello:"none"},
  "prechorus":{violin_1:"legato_melody",violin_2:"harmony_3rd",viola:"pad_chord_tone",cello:"root_sustain"},
  "chorus":{violin_1:"legato_melody",violin_2:"harmony_3rd",viola:"pad_chord_tone",cello:"root_sustain"},
  "bridge":{violin_1:"legato_melody",violin_2:"harmony_3rd",viola:"pad_chord_tone",cello:"root_sustain"},
  "interlude":{violin_1:"legato_melody",violin_2:"harmony_3rd",viola:"pad_chord_tone",cello:"root_sustain"},
  "final_chorus":{violin_1:"legato_melody",violin_2:"harmony_3rd",viola:"pad_chord_tone",cello:"root_sustain"},
  "outro":{violin_1:"legato_melody",violin_2:"harmony_3rd",viola:"pad_chord_tone",cello:"root_sustain"}
};

function StringsGenerator() {
  this.chordIntervals = {
    "maj7":[0,4,7,11],"min7":[0,3,7,10],"dom7":[0,4,7,10],
    "m7b5":[0,3,6,10],"dim7":[0,3,6,9],"add9":[0,4,7,14],
    "sus4":[0,5,7,10],"maj":[0,4,7]
  };
  this.avoidIntervals = {
    "maj7":[5],"dom7":[5],"min7":[],"m7b5":[],"dim7":[],"add9":[5],"sus4":[],"maj":[5]
  };
  this.prevVn1Note = null;
}

StringsGenerator.prototype._getSectionType = function(name) {
  var n = (name || "").toLowerCase().replace(/[\s\-]/g, "");
  if (n.indexOf("final") >= 0 && n.indexOf("chorus") >= 0) return "final_chorus";
  if (n.indexOf("pre") >= 0 && n.indexOf("chorus") >= 0) return "prechorus";
  if (n.indexOf("chorus") >= 0) return "chorus";
  if (n.indexOf("verse") >= 0) {
    if (n.indexOf("2") >= 0 || n.indexOf("ii") >= 0) return "verse_2";
    return "verse";
  }
  if (n.indexOf("intro") >= 0) return "intro";
  if (n.indexOf("bridge") >= 0) return "bridge";
  if (n.indexOf("interlude") >= 0) return "interlude";
  if (n.indexOf("outro") >= 0) return "outro";
  return "verse";
};

StringsGenerator.prototype._getChordTonesInRange = function(root, chordType, rangeTuple) {
  var intervals = this.chordIntervals[chordType] || [0,4,7];
  var minN = rangeTuple[0], maxN = rangeTuple[1];
  var tones = [];
  for (var oct = -2; oct < 4; oct++) {
    var base = 60 + root + oct * 12;
    for (var i = 0; i < intervals.length; i++) {
      var note = base + intervals[i];
      if (note >= minN && note <= maxN && tones.indexOf(note) < 0) tones.push(note);
    }
  }
  return tones.sort(function(a,b){return a-b;});
};

StringsGenerator.prototype._isAvoidNote = function(note, root, chordType) {
  var avoid = this.avoidIntervals[chordType] || [];
  var interval = ((note - root) % 12 + 12) % 12;
  return avoid.indexOf(interval) >= 0;
};

StringsGenerator.prototype._adjustToRange = function(note, range) {
  while (note < range[0]) note += 12;
  while (note > range[1]) note -= 12;
  return note;
};

StringsGenerator.prototype._calcVel = function(baseVel) {
  return clamp(baseVel + rand(-4, 4), 1, 127);
};

StringsGenerator.prototype._generateViolin1 = function(chordInfo, barStart, keyRoot, nextChordInfo, baseVel) {
  var root = (chordInfo.root || 0) + keyRoot;
  var chordType = chordInfo.type || "maj7";
  var notes = [];
  var chordTones = this._getChordTonesInRange(chordInfo.root + keyRoot, chordType, STRING_RANGES.violin_1);
  if (chordTones.length === 0) return [[], this.prevVn1Note];

  var ninthPC = (root + 2) % 12;
  var preferred = chordTones.filter(function(n) { return n % 12 === ninthPC; });

  var mainNote;
  if (this.prevVn1Note !== null && this.prevVn1Note >= STRING_RANGES.violin_1[0] && this.prevVn1Note <= STRING_RANGES.violin_1[1]) {
    var prev = this.prevVn1Note;
    var closeTones = chordTones.slice().sort(function(a,b) { return Math.abs(a-prev) - Math.abs(b-prev); });
    if (preferred.length > 0 && Math.abs(preferred[0] - prev) <= 4) mainNote = preferred[0];
    else mainNote = closeTones[0];
  } else {
    if (preferred.length > 0) mainNote = preferred[0];
    else {
      var mid = Math.floor((STRING_RANGES.violin_1[0] + STRING_RANGES.violin_1[1]) / 2);
      mainNote = chordTones.reduce(function(best, n) { return Math.abs(n-mid) < Math.abs(best-mid) ? n : best; }, chordTones[0]);
    }
  }

  var vel = this._calcVel(baseVel);
  notes.push([mainNote, barStart, 3.5, vel]);

  if (nextChordInfo && Math.random() < 0.3) {
    var nextRoot = (nextChordInfo.root || 0) + keyRoot;
    var nextType = nextChordInfo.type || "maj7";
    var nextTones = this._getChordTonesInRange(nextChordInfo.root + keyRoot, nextType, STRING_RANGES.violin_1);
    if (nextTones.length > 0) {
      var nearest = nextTones.reduce(function(best, n) { return Math.abs(n-mainNote) < Math.abs(best-mainNote) ? n : best; }, nextTones[0]);
      var approach = nearest - 1;
      if (!this._isAvoidNote(approach, root, chordType)) {
        notes.push([approach, barStart + 3.5, 0.5, Math.floor(vel * 0.8)]);
      }
    }
  }
  return [notes, mainNote];
};

StringsGenerator.prototype._generateViolin2 = function(vn1Note, chordInfo, barStart, keyRoot, dynamic, baseVel) {
  if (dynamic < 7 || vn1Note === null) return [];
  var root = (chordInfo.root || 0) + keyRoot;
  var chordType = chordInfo.type || "maj7";
  var chordTones = this._getChordTonesInRange(chordInfo.root + keyRoot, chordType, STRING_RANGES.violin_2);
  var higher = chordTones.filter(function(t) { return t > vn1Note; });
  if (higher.length === 0) return [];
  var target3rd = vn1Note + 3;
  var vn2Note = higher.reduce(function(best, n) { return Math.abs(n-target3rd) < Math.abs(best-target3rd) ? n : best; }, higher[0]);
  var vel = this._calcVel(Math.floor(baseVel * 0.85));
  return [[vn2Note, barStart, 3.5, vel]];
};

StringsGenerator.prototype._generateViola = function(chordInfo, barStart, keyRoot, vn1Note, vn2Note, baseVel) {
  var root = (chordInfo.root || 0) + keyRoot;
  var chordType = chordInfo.type || "maj7";
  var chordTones = this._getChordTonesInRange(chordInfo.root + keyRoot, chordType, STRING_RANGES.viola);
  if (chordTones.length === 0) return [];

  var usedPC = {};
  if (vn1Note !== null) usedPC[vn1Note % 12] = true;
  if (vn2Note !== null) usedPC[vn2Note % 12] = true;

  var fifthPC = (root + 7) % 12;
  var available = chordTones.filter(function(t) { return !usedPC[t % 12]; });
  if (available.length === 0) available = chordTones;

  var minVn = Math.min(vn1Note || 999, vn2Note || 999);
  var candidates = available.filter(function(t) { return t < minVn; });

  var violaNote;
  if (candidates.length > 0) {
    var fifthCands = candidates.filter(function(t) { return t % 12 === fifthPC; });
    violaNote = fifthCands.length > 0 ? fifthCands[0] : candidates[0];
  } else {
    violaNote = Math.min.apply(null, available);
  }
  violaNote = this._adjustToRange(violaNote, STRING_RANGES.viola);
  var vel = this._calcVel(Math.floor(baseVel * 0.75));
  return [[violaNote, barStart, 4.0, vel]];
};

StringsGenerator.prototype._generateCello = function(chordInfo, barStart, keyRoot, nextChordInfo, baseVel) {
  var root = (chordInfo.root || 0) + keyRoot;
  var notes = [];
  var slashBass = chordInfo.slash_bass;
  var bassNote = (slashBass !== null && slashBass !== undefined) ? slashBass + keyRoot : root;
  var celloNote = 36 + (bassNote % 12);
  celloNote = this._adjustToRange(celloNote, STRING_RANGES.cello);
  var vel = this._calcVel(baseVel);
  notes.push([celloNote, barStart, 3.5, vel]);

  if (nextChordInfo && Math.random() < 0.02) {
    var nextRoot = (nextChordInfo.root || 0) + keyRoot;
    var nextSlash = nextChordInfo.slash_bass;
    var nextBass = (nextSlash !== null && nextSlash !== undefined) ? nextSlash + keyRoot : nextRoot;
    var nextCello = 36 + (nextBass % 12);
    nextCello = this._adjustToRange(nextCello, STRING_RANGES.cello);
    var approach = this._adjustToRange(nextCello - 1, STRING_RANGES.cello);
    notes.push([approach, barStart + 3.5, 0.5, Math.floor(vel * 0.7)]);
  }
  return notes;
};

StringsGenerator.prototype.generateStrings = function(previewData, key, bpm, sectionSettings) {
  var vn1Notes = [], vn2Notes = [], violaNotes = [], celloNotes = [];
  var currentBeat = 0;
  var keyRoot = KEY_ROOT[key] || 0;
  this.prevVn1Note = null;

  for (var si = 0; si < previewData.length; si++) {
    var section = previewData[si];
    var sectionName = section.section;
    var bars = section.bars;
    var chords = section.chords || [];
    var sectionType = this._getSectionType(sectionName);
    var isRepeat = section.repeat || false;
    var repeatCount = section.repeatCount || (isRepeat ? 2 : 1);

    var secSettings = sectionSettings ? (sectionSettings[sectionName] || {}) : {};
    var stringsEnabled = secSettings.strings !== false;
    if (!stringsEnabled) { currentBeat += bars * 4 * repeatCount; continue; }

    var config = SECTION_STRING_CONFIG[sectionType] || SECTION_STRING_CONFIG["verse"];
    if (config.violin_1 === "none") { currentBeat += bars * 4 * repeatCount; continue; }

    var dynamic = secSettings.dynamic || 5;
    var baseVel = 60;
    if (sectionType === "final_chorus") baseVel = 75;
    else if (sectionType === "chorus" || sectionType === "bridge") baseVel = 65;
    else if (sectionType === "outro") baseVel = 50;

    for (var ri = 0; ri < repeatCount; ri++) {
      var chordIdx = 0;
      for (var bar = 0; bar < bars; bar++) {
        var barStart = currentBeat + bar * 4;
        var chordInfo = (chords.length > 0 && chordIdx < chords.length) ? chords[chordIdx] : {root:0,type:"maj7"};
        if (chordInfo._skip) { chordIdx++; continue; }
        var nextChordInfo = (chords.length > 0 && chordIdx + 1 < chords.length) ? chords[chordIdx + 1] : null;
        if (nextChordInfo && nextChordInfo._skip) nextChordInfo = null;
        chordIdx++;

        var vn1Result = this._generateViolin1(chordInfo, barStart, keyRoot, nextChordInfo, baseVel);
        var vn1 = vn1Result[0], vn1MainNote = vn1Result[1];
        for (var i = 0; i < vn1.length; i++) vn1Notes.push(vn1[i]);
        this.prevVn1Note = vn1MainNote;

        var vn2 = this._generateViolin2(vn1MainNote, chordInfo, barStart, keyRoot, dynamic, baseVel);
        for (var i = 0; i < vn2.length; i++) vn2Notes.push(vn2[i]);
        var vn2Note = vn2.length > 0 ? vn2[0][0] : null;

        var viola = this._generateViola(chordInfo, barStart, keyRoot, vn1MainNote, vn2Note, baseVel);
        for (var i = 0; i < viola.length; i++) violaNotes.push(viola[i]);

        var cello = this._generateCello(chordInfo, barStart, keyRoot, nextChordInfo, baseVel);
        for (var i = 0; i < cello.length; i++) celloNotes.push(cello[i]);
      }
      currentBeat += bars * 4;
    }
  }
  return {violin_1:vn1Notes, violin_2:vn2Notes, viola:violaNotes, cello:celloNotes};
};

// =============================================================================
// MIDI GENERATOR HELPERS
// =============================================================================

function getHumanizeSettings(sectionName, isFinal) {
  var sl = (sectionName || "").toLowerCase().replace(/[\s\-]/g, "");
  if (isFinal) return HUMANIZE_SETTINGS["final_chorus"];
  if (sl.indexOf("chorus") >= 0 && sl.indexOf("pre") < 0) return HUMANIZE_SETTINGS["chorus"];
  if (sl.indexOf("prechorus") >= 0 || sl.indexOf("pre") >= 0) return HUMANIZE_SETTINGS["prechorus"];
  if (sl.indexOf("verse") >= 0) return HUMANIZE_SETTINGS["verse"];
  if (sl.indexOf("intro") >= 0) return HUMANIZE_SETTINGS["intro"];
  if (sl.indexOf("bridge") >= 0) return HUMANIZE_SETTINGS["bridge"];
  if (sl.indexOf("outro") >= 0) return HUMANIZE_SETTINGS["outro"];
  return HUMANIZE_SETTINGS["verse"];
}

function humanizeTiming(beat, humanize, msPerBeat) {
  var quantize = humanize.quantize || 100;
  var timingVarMs = humanize.timing_var_ms || 0;
  if (quantize >= 100 || timingVarMs === 0) return beat;
  var maxVarRatio = (100 - quantize) / 100.0;
  var rawVar = randFloat(-1, 1);
  var weightedVar = rawVar * Math.abs(rawVar);
  var variationMs = weightedVar * timingVarMs * maxVarRatio;
  var variationBeats = variationMs / msPerBeat;
  return Math.max(0, beat + variationBeats);
}

function humanizeVelocity(velocity, humanize) {
  var velVar = humanize.velocity_var || 0;
  if (velVar === 0) return velocity;
  return clamp(velocity + rand(-velVar, velVar), 1, 127);
}

function getRollingDelays(sectionName) {
  var sl = (sectionName || "").toLowerCase();
  if (sl.indexOf("chorus") >= 0 && sl.indexOf("pre") < 0) return [0, 8, 18, 30];
  if (sl.indexOf("intro") >= 0 || sl.indexOf("outro") >= 0) return [0, 20, 45, 75];
  if (sl.indexOf("verse") >= 0) return [0, 15, 35, 60];
  return [0, 15, 35, 60];
}

function generateSustainPedal(preview, bpm) {
  var events = [];
  var currentBeat = 0;
  var tickOffset = 2 / 480;

  for (var si = 0; si < preview.length; si++) {
    var section = preview[si];
    var bars = section.bars;
    var chords = section.chords || [];
    for (var ci = 0; ci < chords.length; ci++) {
      var chord = chords[ci];
      if (chord._skip) continue;
      var bar = chord.bar !== undefined ? chord.bar : ci;
      var beat = chord.beat || 0;
      var chordBeat = currentBeat + bar * 4 + beat;
      events.push([chordBeat, 127]);
    }
    currentBeat += bars * 4;
  }

  var finalEvents = [];
  for (var i = 0; i < events.length; i++) {
    var beat = events[i][0], value = events[i][1];
    if (i > 0 && value === 127) {
      var releaseBeat = beat + tickOffset;
      var repBeat = releaseBeat + tickOffset;
      finalEvents.push([releaseBeat, 0]);
      finalEvents.push([repBeat, 127]);
    } else {
      finalEvents.push([beat, value]);
    }
  }
  if (finalEvents.length > 0) {
    finalEvents.push([currentBeat + tickOffset, 0]);
  }
  return finalEvents;
}

// =============================================================================
// PUBLIC API: generatePreview
// =============================================================================

function generatePreview(params) {
  var sections = params.sections;
  var key = params.key || "C";
  var bpm = params.bpm || 72;
  var keyRoot = KEY_ROOT[key] || 0;

  var chordGen = new ChordProgressionGenerator(key);
  var voicingGen = new VoicingGenerator(keyRoot);

  var enabledSections = [];
  for (var i = 0; i < sections.length; i++) {
    if (sections[i].enabled !== false) enabledSections.push(sections[i]);
  }

  var lastChorusIdx = -1;
  for (var i = 0; i < enabledSections.length; i++) {
    if ((enabledSections[i].name || "").toLowerCase().indexOf("chorus") >= 0) lastChorusIdx = i;
  }

  var useFlat = FLAT_KEYS[key] || false;
  var noteNames = useFlat ? FLAT_NOTE_NAMES : NOTE_NAMES;
  var toNoteName = function(midi) {
    var octave = Math.floor(midi / 12) - 1;
    return noteNames[midi % 12] + octave;
  };

  var preview = [];
  for (var i = 0; i < enabledSections.length; i++) {
    var sec = enabledSections[i];
    var sectionName = sec.name || sec.type || "Verse";
    var sectionType = getBaseSectionType(sectionName);
    var bars = sec.bars || DEFAULT_SECTION_BARS[sectionType] || 4;
    var isFinalChorus = (i === lastChorusIdx);

    var progression = chordGen.generateProgression(sectionName, bars);

    var sectionPreview = {
      section: sectionName,
      bars: bars,
      chords: []
    };

    for (var ci = 0; ci < progression.length; ci++) {
      var chord = progression[ci];
      var secDynamic = sec.dynamic || null;
      var voicing = voicingGen.generateVoicing(chord, sectionName, isFinalChorus, secDynamic, chord.bar || 0);

      var rootName = noteNames[chord.root];
      var typeMap = {
        "maj7":"maj7","min7":"m7","dom7":"7","m7b5":"m7b5","dim7":"dim7",
        "maj":"","minMaj7":"m(maj7)","min6":"m6","sus4":"sus4","add9":"add9"
      };
      var typeSuffix = typeMap[chord.type] || chord.type;
      var chordName = rootName + typeSuffix;

      if (chord.slash_bass !== null && chord.slash_bass !== undefined) {
        chordName += "/" + noteNames[chord.slash_bass];
      }

      var bassName = toNoteName(voicing.bass);
      var topName = voicing.right_hand.length > 0 ? toNoteName(Math.max.apply(null, voicing.right_hand)) : "-";

      var chordInfo = {
        bar: chord.bar,
        beat: chord.beat || 0,
        duration: chord.duration || 4,
        roman: chord.roman,
        name: chordName,
        root: chord.root,
        type: chord.type,
        bass: bassName,
        top: topName,
        voicing: voicing.all_notes.map(function(n) { return toNoteName(n); }),
        editable: true
      };

      if (chord.hybrid) chordInfo.hybrid = true;
      if (chord.slash_bass !== null && chord.slash_bass !== undefined) chordInfo.slash_bass = chord.slash_bass;

      sectionPreview.chords.push(chordInfo);
    }
    preview.push(sectionPreview);
  }
  return preview;
}

// =============================================================================
// PUBLIC API: generateMIDI
// =============================================================================

function generateMIDI(params) {
  var key = params.key || "C";
  var bpm = params.bpm || 72;
  var sections = params.sections;
  var trackConfig = params.tracks || {piano:true,drum:true,bass:true,strings:true};
  var previewData = params.previewData;
  var sectionSettings = params.sectionSettings || {};
  var arpStyle = params.arpStyle || "none"; // global arpeggio style override
  var keyRoot = KEY_ROOT[key] || 0;

  if (!previewData) previewData = generatePreview(params);

  var msPerBeat = 60000 / bpm;
  var allNotes = [];
  var currentBeat = 0;
  var markers = [];

  var voicingGen = new VoicingGenerator(keyRoot);

  // Build section markers for DAW
  var markerBeat = 0;
  for (var mi = 0; mi < previewData.length; mi++) {
    var mSec = previewData[mi];
    var mRepeat = mSec.repeatCount || (mSec.repeat ? 2 : 1);
    markers.push({ tick: markerBeat * TICKS_PER_BEAT, text: mSec.section });
    markerBeat += mSec.bars * BEATS_PER_BAR * mRepeat;
  }

  // Piano generation
  if (trackConfig.piano !== false) {
    for (var si = 0; si < previewData.length; si++) {
      var section = previewData[si];
      var sectionName = section.section;
      var bars = section.bars;
      var sectionType = getBaseSectionType(sectionName);

      var secSettings = sectionSettings[sectionName] || {};
      var isRepeat = section.repeat || false;
      var repeatCount = section.repeatCount || (isRepeat ? 2 : 1);
      var customDynamic = secSettings.dynamic || null;

      var sectionLower = (sectionName || "").toLowerCase();
      var isChorus = sectionLower.indexOf("chorus") >= 0 && sectionLower.indexOf("pre") < 0;
      var isFinal = sectionLower.indexOf("final") >= 0;
      var humanize = getHumanizeSettings(sectionName, isFinal);
      var totalChords = section.chords.length;

      // Resolve hold/empty chords
      var chords = [];
      var lastValidChord = null;
      if (si > 0) {
        var prevChords = previewData[si-1].chords;
        if (prevChords && prevChords.length > 0) {
          for (var pc = prevChords.length - 1; pc >= 0; pc--) {
            if (prevChords[pc] && !prevChords[pc].empty && prevChords[pc].root !== null && prevChords[pc].root !== undefined) {
              lastValidChord = prevChords[pc]; break;
            }
          }
        }
      }
      for (var ci = 0; ci < section.chords.length; ci++) {
        var c = section.chords[ci];
        if (c.empty) {
          chords.push({bar:c.bar,beat:c.beat||0,duration:c.duration||4,root:null,type:null,_skip:true});
        } else if (c.hold && lastValidChord) {
          chords.push(Object.assign({}, lastValidChord, {bar:c.bar,hold:true}));
        } else if (c.root !== null && c.root !== undefined) {
          chords.push(c);
          lastValidChord = c;
        } else {
          chords.push(c);
        }
      }

      for (var ri = 0; ri < repeatCount; ri++) {
        for (var ci = 0; ci < chords.length; ci++) {
          var chordInfo = chords[ci];
          if (chordInfo._skip) continue;

          var bar = chordInfo.bar !== undefined ? chordInfo.bar : ci;
          var beat = chordInfo.beat || 0;
          var duration = chordInfo.duration || 4;
          var isLastChordOfChorus = isChorus && ci === totalChords - 1 && bar === bars - 1;

          var chord = {
            root: chordInfo.root || 0,
            type: chordInfo.type || "maj7",
            roman: chordInfo.roman || "I",
            slash_bass: chordInfo.slash_bass || null,
            hybrid: chordInfo.hybrid || false
          };

          var voicing = voicingGen.generateVoicing(chord, sectionName, isFinal, customDynamic, bar || 0);
          var barBeat = currentBeat + bar * 4 + beat;
          var velocities = voicing.velocities;

          var effectiveDynamic = customDynamic || SECTION_DYNAMICS[sectionType] || 5;
          var useFourbeat = (isChorus || effectiveDynamic >= 7) && duration >= 4 && !isLastChordOfChorus;

          if (useFourbeat) {
            // Bass once — 최대 2박
            var bassNote = voicing.bass;
            var bassVel = velocities[bassNote] || 85;
            var bassTiming = humanizeTiming(barBeat, humanize, msPerBeat);
            bassVel = humanizeVelocity(bassVel, humanize);
            allNotes.push([bassNote, bassTiming, Math.min(duration, 2), bassVel]);

            // RH every beat
            var rightHand = voicing.right_hand;
            var beatsInChord = Math.floor(duration);
            var dynScale = effectiveDynamic / 10.0;
            var baseStrong = Math.floor(70 + 20 * dynScale);
            var baseWeak = Math.floor(55 + 15 * dynScale);
            var baseMid = Math.floor(62 + 18 * dynScale);
            var fourbeatAccents = [
              [baseStrong, baseStrong + 5],
              [baseWeak, baseWeak + 5],
              [baseMid, baseMid + 5],
              [baseWeak, baseWeak + 5]
            ];
            var tightDelays = [0, 5, 12, 20];

            for (var bo = 0; bo < beatsInChord; bo++) {
              var beatStart = barBeat + bo;
              var beatDur = 0.9;
              var accentIdx = bo % 4;
              var velMin = fourbeatAccents[accentIdx][0], velMax = fourbeatAccents[accentIdx][1];

              for (var ni = 0; ni < rightHand.length; ni++) {
                var note = rightHand[ni];
                var delayMs = tightDelays[Math.min(ni, tightDelays.length - 1)];
                var delayBeats = delayMs / msPerBeat;
                var noteStart = humanizeTiming(beatStart + delayBeats, humanize, msPerBeat);
                var vel = rand(velMin, velMax);
                if (note === Math.max.apply(null, rightHand)) vel = Math.min(vel + 5, 127);
                vel = humanizeVelocity(vel, humanize);
                allNotes.push([note, noteStart, beatDur - delayBeats, vel]);
              }
            }
          } else {
            var useArpeggio = (arpStyle !== "none") || (secSettings.arp || false);
            var leftHand = [voicing.bass].concat(voicing.left_hand || []);
            var rightHand = voicing.right_hand;

            if (useArpeggio && duration >= 4) {
              var bass = voicing.bass;
              var isMinor = chordInfo.type && (chordInfo.type === "min7" || chordInfo.type === "m7b5" || chordInfo.type === "dim7");
              var currentArpStyle = (arpStyle !== "none") ? arpStyle : (SECTION_ARPEGGIO_STYLE[sectionType] || "ascending");
              var arpPattern = ARPEGGIO_PATTERNS[currentArpStyle] || ARPEGGIO_PATTERNS["ascending"];

              for (var ai = 0; ai < arpPattern.length; ai++) {
                var interval = arpPattern[ai][0], beatOffset = arpPattern[ai][1], velRatio = arpPattern[ai][2];
                if (interval === 14 && isMinor) interval = 13;
                else if (interval === 16 && isMinor) interval = 15;
                var arpNote = bass + interval;
                var arpStart = humanizeTiming(barBeat + beatOffset, humanize, msPerBeat);
                var arpBaseVel = Math.floor(70 * velRatio);
                var arpVel = humanizeVelocity(arpBaseVel, humanize);
                var arpDur = Math.max(0.5, duration - beatOffset);
                allNotes.push([arpNote, arpStart, arpDur, arpVel]);
              }

              var rhVoicing = voicing.right_hand;
              var rhBeatOffset = Math.random() > 0.3 ? 2.0 : 2.5;
              var rhStart = humanizeTiming(barBeat + rhBeatOffset, humanize, msPerBeat);
              var rhDelays = [0, 8, 15, 22];
              var sortedRH = rhVoicing.slice().sort(function(a,b){return a-b;});
              for (var ri2 = 0; ri2 < sortedRH.length; ri2++) {
                var delayMs = rhDelays[Math.min(ri2, rhDelays.length - 1)];
                var delayBeats = delayMs / msPerBeat;
                var noteTime = rhStart + delayBeats;
                var noteVel = sortedRH[ri2] === Math.max.apply(null, rhVoicing) ? 75 : 65;
                noteVel = humanizeVelocity(noteVel, humanize);
                var noteDur = Math.max(0.5, duration - rhBeatOffset - delayBeats);
                allNotes.push([sortedRH[ri2], noteTime, noteDur, noteVel]);
              }
            } else {
              // Block chord
              var rollingDelays = getRollingDelays(sectionName);
              var notesToAdd = leftHand.concat(rightHand).sort(function(a,b){return a-b;});

              for (var ni = 0; ni < notesToAdd.length; ni++) {
                var note = notesToAdd[ni];
                var delayMs = rollingDelays[Math.min(ni, rollingDelays.length - 1)];
                var delayBeats = delayMs / msPerBeat;
                var noteStart = humanizeTiming(barBeat + delayBeats, humanize, msPerBeat);
                var vel = velocities[note] || 80;
                vel = humanizeVelocity(vel, humanize);
                allNotes.push([note, noteStart, Math.min(duration - delayBeats, 2), vel]);
              }
            }
          }
        }
        currentBeat += bars * 4;
      }
    }
  }

  // Sustain pedal
  var sustainEvents = generateSustainPedal(previewData, bpm);

  // Drum track
  var drumNotes = null;
  if (trackConfig.drum !== false) {
    var drumGen = new DrumGenerator();
    drumNotes = drumGen.generateDrumTrack(previewData, bpm, sectionSettings);
  }

  // Bass track
  var bassNotes = null;
  if (trackConfig.bass !== false) {
    var bassGen = new BassGenerator();
    bassNotes = bassGen.generateBassTrack(previewData, key, bpm, sectionSettings);
  }

  // Strings track
  var stringsData = null;
  if (trackConfig.strings !== false) {
    var stringsGen = new StringsGenerator();
    stringsData = stringsGen.generateStrings(previewData, key, bpm, sectionSettings);
  }

  // Build MIDI tracks
  var barTicks = TICKS_PER_BEAT * BEATS_PER_BAR;
  var pianoLH = [], pianoRH = [];
  var drumEvents = [], bassEvents = [];
  var vn1Events = [], vn2Events = [], violaEvents = [], celloEvents = [];

  // Piano notes: split at C3(48), deduplicate
  var seenPiano = {};
  for (var i = 0; i < allNotes.length; i++) {
    var pitch = allNotes[i][0], start = allNotes[i][1], dur = allNotes[i][2], vel = allNotes[i][3];
    if (dur <= 0) continue;
    var tick = Math.round(start * TICKS_PER_BEAT);
    var durTicks = Math.round(dur * TICKS_PER_BEAT);
    var skey = pitch + ":" + tick;
    if (seenPiano[skey]) continue;
    seenPiano[skey] = true;
    var ev = {type:'note', tick:tick, pitch:pitch, velocity:clamp(vel,1,127), duration:durTicks};
    if (pitch < 48) pianoLH.push(ev);
    else pianoRH.push(ev);
  }

  // Sustain pedal CC events
  for (var i = 0; i < sustainEvents.length; i++) {
    var sBeat = sustainEvents[i][0], sVal = sustainEvents[i][1];
    var sTick = Math.round(sBeat * TICKS_PER_BEAT);
    pianoLH.push({type:'cc', tick:sTick, cc:64, value:sVal});
    pianoRH.push({type:'cc', tick:sTick, cc:64, value:sVal});
  }

  // Drum notes
  if (drumNotes) {
    var seenDrum = {};
    for (var i = 0; i < drumNotes.length; i++) {
      var note = drumNotes[i][0], start = drumNotes[i][1], dur = drumNotes[i][2], vel = drumNotes[i][3];
      if (dur <= 0) continue;
      var tick = Math.round(start * TICKS_PER_BEAT);
      var durTicks = Math.round(dur * TICKS_PER_BEAT);
      var dkey = note + ":" + tick;
      if (seenDrum[dkey]) continue;
      seenDrum[dkey] = true;
      drumEvents.push({type:'note', tick:tick, pitch:note, velocity:clamp(vel,1,127), duration:durTicks});
    }
  }

  // Bass notes
  if (bassNotes) {
    var seenBass = {};
    for (var i = 0; i < bassNotes.length; i++) {
      var note = bassNotes[i][0], start = bassNotes[i][1], dur = bassNotes[i][2], vel = bassNotes[i][3];
      if (dur <= 0) continue;
      var tick = Math.round(start * TICKS_PER_BEAT);
      var durTicks = Math.round(dur * TICKS_PER_BEAT);
      var bkey = note + ":" + tick;
      if (seenBass[bkey]) continue;
      seenBass[bkey] = true;
      bassEvents.push({type:'note', tick:tick, pitch:note, velocity:clamp(vel,1,127), duration:durTicks});
    }
  }

  // String notes
  if (stringsData) {
    function addStringEvents(arr, dest) {
      var seen = {};
      for (var i = 0; i < arr.length; i++) {
        var note = arr[i][0], start = arr[i][1], dur = arr[i][2], vel = arr[i][3];
        if (dur <= 0) continue;
        var tick = Math.round(start * TICKS_PER_BEAT);
        var durTicks = Math.round(dur * TICKS_PER_BEAT);
        var sk = note + ":" + tick;
        if (seen[sk]) continue;
        seen[sk] = true;
        dest.push({type:'note', tick:tick, pitch:note, velocity:clamp(vel,1,127), duration:durTicks});
      }
    }
    addStringEvents(stringsData.violin_1, vn1Events);
    addStringEvents(stringsData.violin_2, vn2Events);
    addStringEvents(stringsData.viola, violaEvents);
    addStringEvents(stringsData.cello, celloEvents);
  }

  // Build combined MIDI file
  var midiTracks = [];
  if (pianoLH.length > 0) midiTracks.push({name:"Piano LH", channel:0, program:0, events:pianoLH});
  if (pianoRH.length > 0) midiTracks.push({name:"Piano RH", channel:0, program:0, events:pianoRH});
  if (drumEvents.length > 0) midiTracks.push({name:"Drums", channel:9, program:undefined, events:drumEvents});
  if (bassEvents.length > 0) midiTracks.push({name:"Bass", channel:1, program:33, events:bassEvents});
  if (vn1Events.length > 0) midiTracks.push({name:"Violin 1", channel:2, program:40, events:vn1Events});
  if (vn2Events.length > 0) midiTracks.push({name:"Violin 2", channel:4, program:40, events:vn2Events});
  if (violaEvents.length > 0) midiTracks.push({name:"Viola", channel:5, program:41, events:violaEvents});
  if (celloEvents.length > 0) midiTracks.push({name:"Cello", channel:3, program:42, events:celloEvents});

  var midiBytes = buildMidiFile(midiTracks, bpm, markers);
  var blob = new Blob([midiBytes], {type:"audio/midi"});
  var baseName = "MIDext_" + key + "_" + bpm + "bpm_K-Ballad";
  var filename = baseName + ".mid";

  // Build per-instrument MIDI files for ZIP
  var instrumentFiles = [];
  // Piano (LH+RH combined)
  if (pianoLH.length > 0 || pianoRH.length > 0) {
    var pianoTracks = [];
    if (pianoLH.length > 0) pianoTracks.push({name:"Piano LH", channel:0, program:0, events:pianoLH});
    if (pianoRH.length > 0) pianoTracks.push({name:"Piano RH", channel:0, program:0, events:pianoRH});
    var pianoBytes = buildMidiFile(pianoTracks, bpm, markers);
    instrumentFiles.push({name:"piano.mid", data:new Uint8Array(pianoBytes)});
  }
  // Drums
  if (drumEvents.length > 0) {
    var drumBytes = buildMidiFile([{name:"Drums", channel:9, program:undefined, events:drumEvents}], bpm, markers);
    instrumentFiles.push({name:"drums.mid", data:new Uint8Array(drumBytes)});
  }
  // Bass
  if (bassEvents.length > 0) {
    var bassBytes = buildMidiFile([{name:"Bass", channel:1, program:33, events:bassEvents}], bpm, markers);
    instrumentFiles.push({name:"bass.mid", data:new Uint8Array(bassBytes)});
  }
  // Strings (all 4 parts in one file)
  var stringTracks = [];
  if (vn1Events.length > 0) stringTracks.push({name:"Violin 1", channel:2, program:40, events:vn1Events});
  if (vn2Events.length > 0) stringTracks.push({name:"Violin 2", channel:4, program:40, events:vn2Events});
  if (violaEvents.length > 0) stringTracks.push({name:"Viola", channel:5, program:41, events:violaEvents});
  if (celloEvents.length > 0) stringTracks.push({name:"Cello", channel:3, program:42, events:celloEvents});
  if (stringTracks.length > 0) {
    var stringsBytes = buildMidiFile(stringTracks, bpm, markers);
    instrumentFiles.push({name:"strings.mid", data:new Uint8Array(stringsBytes)});
  }

  return {blob:blob, filename:filename, instrumentFiles:instrumentFiles, baseName:baseName};
}

// Expose API
window.MIDextEngine = {
  generatePreview: generatePreview,
  generateMIDI: generateMIDI
};

})();
