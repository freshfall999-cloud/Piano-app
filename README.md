# Keyfall

A piano practice app that runs in the browser with no build step: open `index.html`.

- **Practice** – notes fall onto the keyboard and the song waits until you play the right key.
- **Play** – the song runs in time; hits are scored (Perfect / Good), with streaks, accuracy and stars.
- **Listen** – the app plays the song for you.
- Right hand, left hand or both (the other hand is played for you), adjustable speed.
- **Listen (microphone)** – turn on 🎤 Listen and play a real piano; the app hears each note and waits for the right one.
- **Train on my piano** – play each of the 88 keys once; the app learns how every key sounds through this microphone in this room (and the room's background noise), and listens for each key on the bands where it was actually heard. Training is saved in the browser on that device; untrained keys still use the general listener.
- **Microphone sensitivity** – Low / Normal / High on the song library screen.
- **Ignore talking** (on by default) – speech is rejected because a piano note keeps ringing at a steady pitch after it is struck, while a syllable of speech fades or slides within a fraction of a second. Notes need to ring about 0.2 s to count; turn it off for very short staccato.
- Notes are judged against the room's own background sound in each frequency range, not against fixed loudness levels, so soft playing in a quiet room is heard and fan or traffic rumble doesn't play the song by itself.
- **Note practice** – a note appears on the staff (treble, bass or both, optional ledger lines and sharps/flats) and you find it on the keyboard.
- Input: computer keyboard (Z row = C3 octave, Q row = C4 upward), mouse/touch, or a MIDI keyboard.

The song library screen lists the built-in songs by difficulty and shows your best star rating. **Add your own song** imports a `.mid` file, or a recording (MP3, M4A or WAV) of piano playing: recordings are turned into notes on the device with Spotify's [Basic Pitch](https://github.com/spotify/basic-pitch-ts) model, loaded only the first time it's needed. Imported songs are kept in the browser on that device.

Third-party files: piano samples in `samples/` (Salamander Grand Piano, CC BY 3.0, see `samples/CREDITS.md`); `vendor/basic-pitch/` (Basic Pitch model and code, Apache 2.0) and `vendor/tf.min.js` (TensorFlow.js 3.21, Apache 2.0).

Built-in songs live in `songs.js` as simple note strings and are all public-domain melodies.
