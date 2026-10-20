const fs = require('fs');
const path = require('path');
const vm = require('vm');

function greeting(cfg = {}, loginVoice = null, rejects = false) {
  const html = fs.readFileSync(path.resolve(__dirname, '../../../frontend/dashboard.html'), 'utf8');
  const source = html.slice(html.indexOf('const GreetVoice ='), html.indexOf('\nasync function init()', html.indexOf('const GreetVoice =')));
  const played = [];
  const storage = new Map();
  if (loginVoice !== null) storage.set('abc_greet_on_login', JSON.stringify({ voice: loginVoice }));
  const context = {
    window: { _vgCfg: cfg },
    localStorage: { getItem: () => null },
    sessionStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    document: { getElementById: () => null },
    alert: jest.fn(),
    Audio: function(file) {
      this.paused = true;
      this.pause = () => { this.paused = true; };
      this.play = () => {
        played.push(file);
        this.paused = rejects;
        return rejects ? Promise.reject(new Error('Autoplay blocked')) : Promise.resolve();
      };
    },
  };
  vm.createContext(context);
  vm.runInContext(source + '\nglobalThis.voice = GreetVoice;', context);
  return { voice: context.voice, played, context };
}

test.each(['islam', 'hindu', 'buddhist', 'christian', 'other'])('missing audio setting uses shipped %s greeting', religion => {
  const { voice } = greeting();
  for (const v of ['male', 'female', 'child']) {
    const file = voice.fileForUser({ religion }, v);
    expect(file).toBe(`/audio/greet-${religion}-${v}.mp3`);
    expect(fs.existsSync(path.resolve(__dirname, '../../../frontend' + file))).toBe(true);
  }
});

test('configured audio remains preferred', () => {
  const { voice } = greeting({ audio_files: { islam: { female: ['/uploads/custom.mp3'] } } });
  expect(voice.fileForUser({ religion: 'islam' }, 'female')).toBe('/uploads/custom.mp3');
});

test('disabled greetings do not play', () => {
  const { voice, played } = greeting({ enabled: false });
  expect(voice.fileForUser({ religion: 'islam' }, 'male')).toBeNull();
  voice.maybePlay({ religion: 'islam' });
  expect(played).toEqual([]);
});

test.each([[0, 'male'], [1, 'female'], [2, 'child']])('login voice %s is used for manual and auto playback', (index, label) => {
  const { voice, played, context } = greeting({}, index);
  voice.handleManualClick({ religion: 'islam' });
  voice.stop();
  voice.maybePlay({ religion: 'islam' });
  expect(played).toEqual([`/audio/greet-islam-${label}.mp3`, `/audio/greet-islam-${label}.mp3`]);
  expect(context.alert).not.toHaveBeenCalled();
});

test('rotation off uses configured fixed voice', () => {
  const { voice, played } = greeting({ rotation: false, voice_rotation: 'female' }, 2);
  voice.handleManualClick({ religion: 'islam' });
  expect(played).toEqual(['/audio/greet-islam-female.mp3']);
});

test('unknown religion and invalid voice fall back to other male', () => {
  const { voice } = greeting();
  expect(voice.fileForUser({ religion: 'unknown' }, 'invalid')).toBe('/audio/greet-other-male.mp3');
});

test('blocked autoplay still permits a manual playback attempt', async () => {
  const { voice, played } = greeting({}, null, true);
  voice.maybePlay({ religion: 'islam' });
  await Promise.resolve();
  voice.handleManualClick({ religion: 'islam' });
  await Promise.resolve();
  expect(played).toHaveLength(2);
});