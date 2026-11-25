// Format: space-separated "Note:beats" tokens (beats default to 1). "R" is a rest,
// "C4+E4" is a chord, "~:beats" ties (extends) the previous token, "|" marks a bar line.
// pedal: "bar" (or "beat") plays the song with the sustain pedal, changed at every bar (or beat);
// pedalSkip lists bars (counted from 0) played without it.
const e8 = s => s.split(" ").map(n => n + ":.5").join(" ");      // run of eighth notes
const rep = (s, n) => Array(n).fill(s).join(" | ");

// Bach, Prelude in C: each bar is one broken chord played twice.
const PRELUDE = ["C4 E4 G4 C5 E5", "C4 D4 A4 D5 F5", "B3 D4 G4 D5 F5", "C4 E4 G4 C5 E5",
  "C4 E4 A4 E5 A5", "C4 D4 F#4 A4 D5", "B3 D4 G4 D5 G5", "B3 C4 E4 G4 C5"]
  .map(ch => { const [a, b, c, d, f] = ch.split(" "); const h = [a, b, c, d, f, c, d, f].map(n => n + ":.25").join(" "); return h + " " + h; })
  .join(" | ") + " | C4+E4+G4+C5:4";

const SONGS = [
  {
    title: "Mary Had a Little Lamb", by: "Traditional", level: "Easy", bpm: 110,
    right: "E4 D4 C4 D4 | E4 E4 E4:2 | D4 D4 D4:2 | E4 G4 G4:2 | E4 D4 C4 D4 | E4 E4 E4 E4 | D4 D4 E4 D4 | C4:4",
  },
  {
    title: "Twinkle, Twinkle, Little Star", by: "Traditional", level: "Easy", bpm: 100,
    right: "C4 C4 G4 G4 | A4 A4 G4:2 | F4 F4 E4 E4 | D4 D4 C4:2 | G4 G4 F4 F4 | E4 E4 D4:2 | G4 G4 F4 F4 | E4 E4 D4:2 | C4 C4 G4 G4 | A4 A4 G4:2 | F4 F4 E4 E4 | D4 D4 C4:2",
    left: "C3:4 | F3:2 C3:2 | F3:2 C3:2 | G3:2 C3:2 | C3:2 F3:2 | C3:2 G3:2 | C3:2 F3:2 | C3:2 G3:2 | C3:4 | F3:2 C3:2 | F3:2 C3:2 | G3:2 C3:2",
  },
  {
    title: "London Bridge", by: "Traditional", level: "Easy", bpm: 120,
    right: "G4:1.5 A4:.5 G4 F4 | E4 F4 G4:2 | D4 E4 F4:2 | E4 F4 G4:2 | G4:1.5 A4:.5 G4 F4 | E4 F4 G4:2 | D4:2 G4:2 | E4 C4:3",
  },
  {
    title: "Frère Jacques", by: "Traditional", level: "Easy", bpm: 110,
    right: "C4 D4 E4 C4 | C4 D4 E4 C4 | E4 F4 G4:2 | E4 F4 G4:2 | G4:.5 A4:.5 G4:.5 F4:.5 E4 C4 | G4:.5 A4:.5 G4:.5 F4:.5 E4 C4 | C4 G3 C4:2 | C4 G3 C4:2",
  },
  {
    title: "Row, Row, Row Your Boat", by: "Traditional", level: "Easy", bpm: 150,
    right: "C4:1.5 C4:1.5 | C4 D4:.5 E4:1.5 | E4 D4:.5 E4 F4:.5 | G4:3 | " + e8("C5 C5 C5 G4 G4 G4") + " | " + e8("E4 E4 E4 C4 C4 C4") + " | G4 F4:.5 E4 D4:.5 | C4:3",
  },
  {
    title: "Yankee Doodle", by: "Traditional", level: "Easy", bpm: 130,
    right: "C4 C4 D4 E4 | C4 E4 D4 G3 | C4 C4 D4 E4 | C4:2 B3:2 | C4 C4 D4 E4 | F4 E4 D4 C4 | B3 G3 A3 B3 | C4:2 C4:2",
  },
  {
    title: "Happy Birthday", by: "Traditional", level: "Easy", bpm: 100,
    right: "G4:.75 G4:.25 | A4 G4 C5 | B4:2 G4:.75 G4:.25 | A4 G4 D5 | C5:2 G4:.75 G4:.25 | G5 E5 C5 | B4 A4 F5:.75 F5:.25 | E5 C5 D5 | C5:3",
  },
  {
    title: "Ode to Joy", by: "Beethoven", level: "Easy", bpm: 116,
    right: "E4 E4 F4 G4 | G4 F4 E4 D4 | C4 C4 D4 E4 | E4:1.5 D4:.5 D4:2 | E4 E4 F4 G4 | G4 F4 E4 D4 | C4 C4 D4 E4 | D4:1.5 C4:.5 C4:2 | D4 D4 E4 C4 | D4 E4:.5 F4:.5 E4 C4 | D4 E4:.5 F4:.5 E4 D4 | C4 D4 G3:2 | E4 E4 F4 G4 | G4 F4 E4 D4 | C4 C4 D4 E4 | D4:1.5 C4:.5 C4:2",
    left: "C3:4 | G3:4 | C3:4 | G3:4 | C3:4 | G3:4 | C3:4 | G3:2 C3:2 | G3:2 C3:2 | G3:2 C3:2 | G3:2 C3:2 | R:4 | C3:4 | G3:4 | C3:4 | G3:2 C3:2",
  },
  {
    title: "Jingle Bells (chorus)", by: "J. Pierpont", level: "Easy", bpm: 120,
    right: "E4 E4 E4:2 | E4 E4 E4:2 | E4 G4 C4:1.5 D4:.5 | E4:4 | F4 F4 F4:1.5 F4:.5 | F4 E4 E4 E4:.5 E4:.5 | E4 D4 D4 E4 | D4:2 G4:2 | E4 E4 E4:2 | E4 E4 E4:2 | E4 G4 C4:1.5 D4:.5 | E4:4 | F4 F4 F4:1.5 F4:.5 | F4 E4 E4 E4:.5 E4:.5 | G4 G4 F4 D4 | C4:4",
    left: "C3:4 | C3:4 | C3:4 | C3:4 | F3:4 | C3:4 | G3:4 | G3:4 | C3:4 | C3:4 | C3:4 | C3:4 | F3:4 | C3:4 | G3:4 | C3:4",
  },
  {
    title: "When the Saints Go Marching In", by: "Traditional", level: "Easy", bpm: 130,
    right: "R C4 E4 F4 | G4:4 | R C4 E4 F4 | G4:4 | R C4 E4 F4 | G4:2 E4:2 | C4:2 E4:2 | D4:4 | R E4 E4 D4 | C4:3 C4 | E4:2 G4:2 | G4 F4:3 | R:2 E4 F4 | G4:2 E4:2 | C4:2 D4:2 | C4:4",
  },
  {
    title: "Amazing Grace", by: "Traditional", level: "Medium", bpm: 90, pedal: "bar", pedalSkip: [0],
    right: "D4 | G4:2 B4:.5 G4:.5 | B4:2 A4 | G4:2 E4 | D4:2 D4 | G4:2 B4:.5 G4:.5 | B4:2 A4 | D5:3 | D5:2 B4 | D5:1.5 B4:.5 D5:.5 B4:.5 | G4:2 D4 | E4:1.5 G4:.5 G4:.5 E4:.5 | D4:2 D4 | G4:2 B4:.5 G4:.5 | B4:2 A4 | G4:3",
  },
  {
    title: "Brahms' Lullaby", by: "Brahms", level: "Medium", bpm: 90, pedal: "bar", pedalSkip: [0],
    right: "E4:.5 E4:.5 | G4:2 E4:.5 E4:.5 | G4:2 E4:.5 G4:.5 | C5 B4:1.5 A4:.5 | A4 G4 D4:.5 E4:.5 | F4 D4 D4:.5 E4:.5 | F4:2 D4:.5 F4:.5 | B4:.5 A4:.5 G4 B4 | C5:2 C4:.5 C4:.5 | C5:2 A4:.5 F4:.5 | G4:2 E4:.5 C4:.5 | F4 G4 A4 | G4:2 C4:.5 C4:.5 | C5:2 A4:.5 F4:.5 | G4:2 E4:.5 C4:.5 | F4 E4 D4 | C4:3",
  },
  {
    title: "Greensleeves", by: "Traditional", level: "Medium", bpm: 110, pedal: "bar", pedalSkip: [0],
    right: "A4:.5 | C5 D5:.5 E5:.75 F5:.25 E5:.5 | D5 B4:.5 G4:.75 A4:.25 B4:.5 | C5 A4:.5 A4:.75 G#4:.25 A4:.5 | B4 G#4:.5 E4 A4:.5 | C5 D5:.5 E5:.75 F5:.25 E5:.5 | D5 B4:.5 G4:.75 A4:.25 B4:.5 | C5:.75 B4:.25 A4:.5 G#4:.75 F#4:.25 G#4:.5 | A4:3 | G5:1.5 G5:.75 F5:.25 E5:.5 | D5 B4:.5 G4:.75 A4:.25 B4:.5 | C5 A4:.5 A4:.75 G#4:.25 A4:.5 | B4 G#4:.5 E4:1.5 | G5:1.5 G5:.75 F5:.25 E5:.5 | D5 B4:.5 G4:.75 A4:.25 B4:.5 | C5:.75 B4:.25 A4:.5 G#4:.75 F#4:.25 G#4:.5 | A4:3",
  },
  {
    title: "Minuet in G", by: "Petzold", level: "Medium", bpm: 100,
    right: "D5 G4:.5 A4:.5 B4:.5 C5:.5 | D5 G4 G4 | E5 C5:.5 D5:.5 E5:.5 F#5:.5 | G5 G4 G4 | C5 D5:.5 C5:.5 B4:.5 A4:.5 | B4 C5:.5 B4:.5 A4:.5 G4:.5 | F#4 G4:.5 A4:.5 B4:.5 G4:.5 | B4 A4:2",
    left: "G3:2 A3 | B3:3 | C4:3 | B3:3 | A3:3 | G3:3 | D4 B3 G3 | D4 D3:2",
  },
  {
    title: "Canon in D", by: "Pachelbel", level: "Medium", bpm: 66, pedal: "beat",
    right: "F#5 E5 D5 C#5 | B4 A4 B4 C#5 | D5 C#5 B4 A4 | G4 F#4 G4 E4 | " + e8("D4 F#4 A4 G4 F#4 D4 F#4 E4") + " | " + e8("D4 B3 D4 A4 G4 B4 A4 G4") + " | F#4:4",
    left: rep("D3 A2 B2 F#2 | G2 D2 G2 A2", 3) + " | D3:4",
  },
  {
    title: "Für Elise (opening)", by: "Beethoven", level: "Medium", bpm: 126, pedal: "bar", pedalSkip: [0, 1, 4, 5],
    right: "E5:.5 D#5:.5 | E5:.5 D#5:.5 E5:.5 B4:.5 D5:.5 C5:.5 | A4 R:.5 C4:.5 E4:.5 A4:.5 | B4 R:.5 E4:.5 G#4:.5 B4:.5 | C5 R:.5 E4:.5 E5:.5 D#5:.5 | E5:.5 D#5:.5 E5:.5 B4:.5 D5:.5 C5:.5 | A4 R:.5 C4:.5 E4:.5 A4:.5 | B4 R:.5 E4:.5 C5:.5 B4:.5 | A4:2",
  },
  {
    title: "Prelude in C", by: "J. S. Bach", level: "Hard", bpm: 66, pedal: "bar",
    right: PRELUDE,
  },
];
