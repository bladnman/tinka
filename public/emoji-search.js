import { emojiSticker, favoriteEmoji } from './emoji-stickers.js';

const key = emoji => emoji.replaceAll('\uFE0F', '');
const words = text => text.normalize('NFKD').replace(/\p{Mark}/gu, '').toLowerCase().match(/[a-z0-9]+/g) || [];
const withTone = /[\u{1F3FB}-\u{1F3FF}]/u;

const favorites = new Map(favoriteEmoji.map(entry => [key(entry[0]), entry]));

export function makeEmojiSearch(entries, groups) {
  const choices = entries.map(([emoji, officialName, keywords, group]) => {
    const favorite = favorites.get(key(emoji));
    const name = favorite?.[1] || officialName[0].toUpperCase() + officialName.slice(1);
    const nameTerms = words(officialName);
    const names = [nameTerms.join(' '), words(name).join(' ')];
    const terms = [...new Set([...nameTerms, ...words(`${name} ${keywords} ${favorite?.[2] || ''}`)])];
    const tone = withTone.test(emoji) && groups[group] !== 'Component';
    return { emoji, name, group, names, nameTerms, terms, tone, favorite: Boolean(favorite) };
  });
  const byEmoji = new Map(choices.map(choice => [key(choice.emoji), choice]));
  const byGroup = groups.map((_, index) => choices.filter(choice => choice.group === index));

  return function find(query, group, includeTones) {
    const pasted = emojiSticker(query);
    if (pasted) {
      const known = byEmoji.get(key(pasted));
      return { entries: [[pasted, known?.name || 'Pasted emoji']], canShowTones: false };
    }
    const queryTerms = words(query);
    if (query.trim() && !queryTerms.length) return { entries: [], canShowTones: false };
    if (!queryTerms.length && group === -1) return { entries: favoriteEmoji, canShowTones: false };

    let matches = byGroup[group] || [];
    if (queryTerms.length) {
      const phrase = queryTerms.join(' ');
      const score = choice => {
        if (choice.names.includes(phrase)) return 400;
        if (choice.names.some(name => name.startsWith(phrase))) return 300;
        if (queryTerms.every(term => choice.nameTerms.some(name => name.startsWith(term)))) return 200;
        return choice.favorite ? 100 : 0;
      };
      matches = choices
        .filter(choice => queryTerms.every(term => choice.terms.some(word => word.startsWith(term))))
        .map(choice => ({ choice, score: score(choice) }))
        .sort((a, b) => b.score - a.score)
        .map(({ choice }) => choice);
    }
    const explicitTone = queryTerms.includes('tone') || queryTerms.includes('skin');
    const canShowTones = !explicitTone && matches.some(choice => choice.tone);
    const visible = includeTones || explicitTone ? matches : matches.filter(choice => !choice.tone);
    return { entries: visible.map(({ emoji, name }) => [emoji, name]), canShowTones };
  };
}
