// Songs are public-domain melodies. Format: space-separated "Note:beats" tokens
// (beats default to 1), "R" is a rest, "C4+E4" is a chord. "|" is ignored.
const SONGS = [
  {
    title: "Mary Had a Little Lamb", bpm: 110,
    right: "E4 D4 C4 D4 | E4 E4 E4:2 | D4 D4 D4:2 | E4 G4 G4:2 | E4 D4 C4 D4 | E4 E4 E4 E4 | D4 D4 E4 D4 | C4:4",
  },
  {
    title: "Twinkle, Twinkle, Little Star", bpm: 100,
    right: "C4 C4 G4 G4 | A4 A4 G4:2 | F4 F4 E4 E4 | D4 D4 C4:2 | G4 G4 F4 F4 | E4 E4 D4:2 | G4 G4 F4 F4 | E4 E4 D4:2 | C4 C4 G4 G4 | A4 A4 G4:2 | F4 F4 E4 E4 | D4 D4 C4:2",
    left: "C3:4 | F3:2 C3:2 | F3:2 C3:2 | G3:2 C3:2 | C3:2 F3:2 | C3:2 G3:2 | C3:2 F3:2 | C3:2 G3:2 | C3:4 | F3:2 C3:2 | F3:2 C3:2 | G3:2 C3:2",
  },
  {
    title: "Frère Jacques", bpm: 110,
    right: "C4 D4 E4 C4 | C4 D4 E4 C4 | E4 F4 G4:2 | E4 F4 G4:2 | G4:.5 A4:.5 G4:.5 F4:.5 E4 C4 | G4:.5 A4:.5 G4:.5 F4:.5 E4 C4 | C4 G3 C4:2 | C4 G3 C4:2",
  },
  {
    title: "Ode to Joy", bpm: 116,
    right: "E4 E4 F4 G4 | G4 F4 E4 D4 | C4 C4 D4 E4 | E4:1.5 D4:.5 D4:2 | E4 E4 F4 G4 | G4 F4 E4 D4 | C4 C4 D4 E4 | D4:1.5 C4:.5 C4:2 | D4 D4 E4 C4 | D4 E4:.5 F4:.5 E4 C4 | D4 E4:.5 F4:.5 E4 D4 | C4 D4 G3:2 | E4 E4 F4 G4 | G4 F4 E4 D4 | C4 C4 D4 E4 | D4:1.5 C4:.5 C4:2",
    left: "C3:4 | G3:4 | C3:4 | G3:4 | C3:4 | G3:4 | C3:4 | G3:2 C3:2 | G3:2 C3:2 | G3:2 C3:2 | G3:2 C3:2 | R:4 | C3:4 | G3:4 | C3:4 | G3:2 C3:2",
  },
  {
    title: "Jingle Bells (chorus)", bpm: 120,
    right: "E4 E4 E4:2 | E4 E4 E4:2 | E4 G4 C4:1.5 D4:.5 | E4:4 | F4 F4 F4:1.5 F4:.5 | F4 E4 E4 E4:.5 E4:.5 | E4 D4 D4 E4 | D4:2 G4:2 | E4 E4 E4:2 | E4 E4 E4:2 | E4 G4 C4:1.5 D4:.5 | E4:4 | F4 F4 F4:1.5 F4:.5 | F4 E4 E4 E4:.5 E4:.5 | G4 G4 F4 D4 | C4:4",
    left: "C3:4 | C3:4 | C3:4 | C3:4 | F3:4 | C3:4 | G3:4 | G3:4 | C3:4 | C3:4 | C3:4 | C3:4 | F3:4 | C3:4 | G3:4 | C3:4",
  },
  {
    title: "Minuet in G (Petzold)", bpm: 100,
    right: "D5 G4:.5 A4:.5 B4:.5 C5:.5 | D5 G4 G4 | E5 C5:.5 D5:.5 E5:.5 F#5:.5 | G5 G4 G4 | C5 D5:.5 C5:.5 B4:.5 A4:.5 | B4 C5:.5 B4:.5 A4:.5 G4:.5 | F#4 G4:.5 A4:.5 B4:.5 G4:.5 | B4 A4:2",
    left: "G3:2 A3 | B3:3 | C4:3 | B3:3 | A3:3 | G3:3 | D4 B3 G3 | D4 D3:2",
  },
  {
    title: "Für Elise (opening)", bpm: 126,
    right: "E5:.5 D#5:.5 | E5:.5 D#5:.5 E5:.5 B4:.5 D5:.5 C5:.5 | A4 R:.5 C4:.5 E4:.5 A4:.5 | B4 R:.5 E4:.5 G#4:.5 B4:.5 | C5 R:.5 E4:.5 E5:.5 D#5:.5 | E5:.5 D#5:.5 E5:.5 B4:.5 D5:.5 C5:.5 | A4 R:.5 C4:.5 E4:.5 A4:.5 | B4 R:.5 E4:.5 C5:.5 B4:.5 | A4:2",
  },
];
