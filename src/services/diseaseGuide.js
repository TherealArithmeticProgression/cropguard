import englishGuide from '../../disease_prevention_and_best_practises/tomato-disease-guide-en.md?raw';
import hindiGuide from '../../disease_prevention_and_best_practises/tomato-disease-guide-hi.md?raw';
import punjabiGuide from '../../disease_prevention_and_best_practises/tomato-disease-guide-pa.md?raw';
import bengaliGuide from '../../disease_prevention_and_best_practises/tomato-disease-guide-bn.md?raw';
import tamilGuide from '../../disease_prevention_and_best_practises/tomato-disease-guide-ta.md?raw';

const sourceByLanguage = {
  en: englishGuide,
  hi: hindiGuide,
  pa: punjabiGuide,
  bn: bengaliGuide,
  ta: tamilGuide,
};

const diseaseSectionIndex = {
  septoria_leaf_spot: 0,
  early_blight: 1,
  bacterial_spot: 2,
  late_blight: 3,
};

function cleanMarkdown(value) {
  return value
    .replace(/^\*\*(.+?)\*\*:?\s*/, '$1: ')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/::/g, ':')
    .trim();
}

function parseGuide(markdown) {
  const lines = markdown.split(/\r?\n/);
  const guide = { title: '', intro: '', warning: '', sections: [] };
  let current = null;
  let paragraph = [];
  let list = [];
  let inWarning = false;

  const flushParagraph = () => {
    if (paragraph.length && current) {
      current.paragraphs.push(cleanMarkdown(paragraph.join(' ')));
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list.length && current) {
      current.actions.push(...list.map(cleanMarkdown));
      list = [];
    }
  };

  lines.forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      flushList();
      return;
    }
    if (line.startsWith('# ') && !guide.title) {
      guide.title = cleanMarkdown(line.slice(2));
      return;
    }
    if (line.startsWith('### ')) return;
    if (line.startsWith('> ')) {
      guide.warning += `${guide.warning ? ' ' : ''}${cleanMarkdown(line.slice(2))}`;
      inWarning = true;
      return;
    }
    if (inWarning && !line.startsWith('> ')) inWarning = false;
    if (line.startsWith('## ')) {
      flushParagraph();
      flushList();
      current = { title: cleanMarkdown(line.slice(3)), paragraphs: [], actions: [] };
      guide.sections.push(current);
      return;
    }
    if (!current) {
      if (line.startsWith('*') && line.endsWith('*')) guide.intro = cleanMarkdown(line);
      return;
    }
    if (line.startsWith('- ')) {
      flushParagraph();
      list.push(line.slice(2));
      return;
    }
    if (!line.startsWith('*') && !line.startsWith('---')) paragraph.push(line);
  });

  flushParagraph();
  flushList();
  guide.warning = cleanMarkdown(guide.warning);
  return guide;
}

export function getDiseaseGuide(language) {
  return parseGuide(sourceByLanguage[language] || sourceByLanguage.en);
}

export function getDiseaseTreatment(language, diseaseLabel) {
  const sectionIndex = diseaseSectionIndex[diseaseLabel];
  if (sectionIndex == null) return '';
  const section = getDiseaseGuide(language).sections[sectionIndex];
  return section?.actions.at(-1) || '';
}
