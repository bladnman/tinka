import { newEmoji } from './emoji-repertoire-additions.js';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const pictograph = String.raw`(?=\p{Emoji})\p{Extended_Pictographic}`;
const emojiPart = String.raw`(?:(?=\p{Emoji_Modifier_Base})${pictograph}\uFE0F?\p{Emoji_Modifier}|${pictograph}\uFE0F?)`;
const pictographSequence = new RegExp(String.raw`^${emojiPart}(?:\u200D${emojiPart})*$`, 'u');
const flag = /^(?:\p{Regional_Indicator}{2}|\u{1F3F4}[\u{E0061}-\u{E007A}]{2,8}\u{E007F})$/u;
const keycap = /^[0-9#*]\uFE0F?\u20E3$/u;

export const EMOJI_STICKER_MIME = 'application/x-tinka-emoji';

export function emojiSticker(text) {
  if (typeof text !== 'string') return null;
  const emoji = text.trim();
  // Bound the input before segmenting. Preserve the original presentation,
  // modifiers, and joiners so a pasted emoji renders as the author chose it.
  if (!emoji || emoji.length > 32 || /^[©®™]$/u.test(emoji)) return null;
  // Older runtimes may not know the latest emoji properties or boundaries yet.
  if (newEmoji.has(emoji) || /^[\u{1F3FB}-\u{1F3FF}\u{1F9B0}-\u{1F9B3}]$/u.test(emoji)) return emoji;
  if (!flag.test(emoji) && !keycap.test(emoji) && !pictographSequence.test(emoji)) return null;
  return graphemes.segment(emoji).containing(0)?.segment === emoji ? emoji : null;
}

// Board-friendly choices first, with English names and search aliases.
export const favoriteEmoji = [
  ['💡', 'Light bulb', 'idea insight brainstorm'],
  ['🎯', 'Target', 'goal focus bullseye objective'],
  ['✅', 'Check mark', 'done yes approved complete success green tick'],
  ['⭐', 'Star', 'favorite highlight important'],
  ['🚀', 'Rocket', 'launch ship release deploy'],
  ['🔥', 'Fire', 'hot on fire trending priority'],
  ['🎉', 'Party popper', 'celebrate congratulations milestone confetti'],
  ['👀', 'Eyes', 'look review attention see'],
  ['👍', 'Thumbs up', 'approve yes like good agree'],
  ['👎', 'Thumbs down', 'reject no dislike disagree'],
  ['❤️', 'Red heart', 'love favorite'],
  ['⚠️', 'Warning', 'caution attention danger risk'],
  ['❓', 'Question mark', 'ask unclear help'],
  ['❗', 'Exclamation mark', 'urgent important emphasis'],
  ['❌', 'Cross mark', 'wrong no reject fail red x'],
  ['🚧', 'Construction', 'in progress blocked building work'],
  ['🐛', 'Bug', 'issue defect insect'],
  ['🔍', 'Magnifying glass', 'search inspect investigate research zoom'],
  ['🧪', 'Test tube', 'experiment science testing lab'],
  ['🧩', 'Puzzle piece', 'component fit part jigsaw'],
  ['🗺️', 'Map', 'roadmap journey plan direction'],
  ['🧭', 'Compass', 'direction navigation strategy'],
  ['📌', 'Pushpin', 'pin focus mark location'],
  ['📍', 'Round pushpin', 'location marker map pin'],
  ['🚩', 'Red flag', 'risk marker challenge warning'],
  ['🏁', 'Chequered flag', 'checkered finish milestone race done'],
  ['⏳', 'Hourglass', 'waiting pending time'],
  ['⏰', 'Alarm clock', 'time deadline reminder'],
  ['🗓️', 'Calendar', 'schedule day date plan'],
  ['📝', 'Memo', 'note notes writing edit'],
  ['📋', 'Clipboard', 'checklist tasks plan'],
  ['📎', 'Paperclip', 'attach file resource'],
  ['🔗', 'Link', 'connection reference chain'],
  ['💬', 'Speech bubble', 'comment feedback talk chat'],
  ['💭', 'Thought bubble', 'idea think brainstorm'],
  ['📣', 'Megaphone', 'announce announcement shout'],
  ['🔔', 'Bell', 'alert notification reminder'],
  ['🔖', 'Bookmark', 'save mark reference'],
  ['🛠️', 'Hammer and wrench', 'build fix tools repair'],
  ['⚙️', 'Gear', 'settings automation mechanical preferences'],
  ['🔧', 'Wrench', 'fix tool spanner'],
  ['🔑', 'Key', 'access unlock security'],
  ['🔒', 'Locked', 'security lock private'],
  ['🔓', 'Unlocked', 'open lock access'],
  ['🛑', 'Stop sign', 'blocked halt pause danger'],
  ['🎨', 'Artist palette', 'design colors art paint'],
  ['✨', 'Sparkles', 'new shine polish magic'],
  ['✏️', 'Pencil', 'edit sketch draw writing'],
  ['📐', 'Triangular ruler', 'measure layout design'],
  ['📏', 'Straight ruler', 'measure size design'],
  ['✂️', 'Scissors', 'cut trim edit'],
  ['🎬', 'Clapper board', 'video film take scene'],
  ['🎥', 'Movie camera', 'video production film record'],
  ['📸', 'Camera with flash', 'photo picture image screenshot'],
  ['🎧', 'Headphones', 'audio listen music sound'],
  ['🎙️', 'Microphone', 'audio record voice podcast'],
  ['🖼️', 'Framed picture', 'image art reference'],
  ['🖥️', 'Desktop computer', 'screen monitor ui display'],
  ['📱', 'Mobile phone', 'app phone device'],
  ['💻', 'Laptop', 'code computer development'],
  ['🤖', 'Robot', 'ai agent automation'],
  ['📦', 'Package', 'box shipping build bundle'],
  ['📚', 'Books', 'library research read documentation'],
  ['📊', 'Bar chart', 'data metrics analytics'],
  ['📈', 'Chart increasing', 'growth trend data'],
  ['🏆', 'Trophy', 'win award success'],
  ['🥇', 'Gold medal', 'first winner award'],
  ['🙌', 'Raising hands', 'celebrate hooray praise'],
  ['👏', 'Clapping hands', 'applause praise well done'],
  ['🤝', 'Handshake', 'agree deal partnership'],
  ['👋', 'Waving hand', 'wave hello goodbye'],
  ['👉', 'Pointing right', 'hand pointer direction next'],
  ['👈', 'Pointing left', 'hand pointer direction back'],
  ['⬆️', 'Up arrow', 'direction above'],
  ['⬇️', 'Down arrow', 'direction below'],
  ['➡️', 'Right arrow', 'direction next'],
  ['⬅️', 'Left arrow', 'direction previous'],
  ['🔄', 'Counterclockwise arrows', 'refresh repeat loop rotate sync'],
  ['😊', 'Smiling face', 'happy smile glad face'],
  ['😎', 'Sunglasses', 'cool smile face'],
  ['😍', 'Heart eyes', 'love smile face'],
  ['😂', 'Face with tears of joy', 'lol laugh funny smile face'],
  ['🤔', 'Thinking face', 'think hmm curious question'],
  ['😬', 'Grimacing face', 'awkward concern nervous'],
  ['😮', 'Face with open mouth', 'surprised shock wow'],
  ['😕', 'Confused face', 'unsure concern'],
  ['🙈', 'See-no-evil monkey', 'hide embarrassed animal'],
  ['💯', 'Hundred points', '100 perfect score'],
  ['💥', 'Collision', 'explosion boom impact'],
  ['⚡', 'Lightning bolt', 'power fast speed'],
  ['🌈', 'Rainbow', 'color weather'],
  ['☀️', 'Sun', 'bright light weather'],
  ['🌙', 'Crescent moon', 'night dark'],
  ['🌱', 'Seedling', 'grow growth plant'],
  ['🍀', 'Four-leaf clover', 'luck lucky plant'],
  ['🌻', 'Sunflower', 'plant flower yellow'],
  ['🐈', 'Cat', 'pet kitten animal'],
  ['🐕', 'Dog', 'pet puppy animal'],
  ['🦋', 'Butterfly', 'insect animal'],
  ['☕', 'Coffee', 'tea mug hot beverage break'],
  ['🎁', 'Gift', 'present reward'],
  ['🍕', 'Pizza', 'food slice'],
];

