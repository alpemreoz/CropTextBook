// Book profiles: settings for book series whose layout needs handling the
// default pipeline doesn't do. No profile means the defaults below, which
// are exactly the behaviour every earlier book was verified with.
//
//   node cli/qcrop.mjs book.pdf --profile apotemi
//
// Each profile only lists what differs from DEFAULTS.

export const DEFAULTS = {
  // Pages may start with a question right at the top (no header banner):
  // question numbers read from the column margins move the content top up
  // when the header band turns out to hold the first questions.
  headerFromLabels: false,
  // A thin band of ink at the left/right page edge, set apart by a gap
  // (vertical spine text, scan shadows), is left out of the columns.
  trimEdgeText: false,
  // Footers start below this fraction of the page height; a lower "footer"
  // band is the page's last questions (null = no limit).
  footerZone: null,
  // Without a visible divider, the column gutter is the leftmost blank run
  // (question numbers hang right of it; the gap after them isn't the gutter;
  // for books with a logo in the gutter).
  leftmostGutter: false,
  // For finding the gutter, ink confined to one short stretch of the page
  // (a vertical publisher logo in the gutter) doesn't count.
  ignoreGutterLogo: false,

  // OCR input: skip a "question" whose options start on its number's line
  // (answer-sheet rows). Books with one-line questions need it off.
  answerSheetGuard: true,
  // Numbering may start over on a page (learning pages: 1, 2, 3 under each
  // sub-heading); the increasing-number check then runs per group.
  numberingRestarts: false,
  // Names per test: a test's number and topic, read on any of its pages,
  // name all of its crops (tests found from where numbering starts over).
  namesPerTest: false,
  // Header text never used as a topic (regex sources, case-insensitive).
  topicIgnore: [],
  // Printed answers to read per page, for answers.csv and the self-check:
  // null, or { band: 'bottom' | 'top' }.
  answerKey: null,
};

export const PROFILES = {
  bilgisarmal: {
    label: 'Bilgi Sarmal – TYT Matematik Soru Bankası',
    headerFromLabels: true,
    trimEdgeText: true,
    footerZone: 0.92,
    ignoreGutterLogo: true,
    answerSheetGuard: false,
    namesPerTest: true,
    answerKey: { band: 'bottom' },
  },
  orijinal: {
    label: 'Orijinal Yayınları – TYT Matematik Soru Bankası',
    topicIgnore: ['ösym tarzı', 'tarzı sorular'],
    headerFromLabels: true,
    trimEdgeText: true,
    footerZone: 0.92,
    ignoreGutterLogo: true,
    answerSheetGuard: false,
    namesPerTest: true,
    answerKey: { band: 'bottom' },
  },
  acil: {
    label: 'Acil Yayınları – TYT Matematik Kurs Soru Bankası',
    topicIgnore: ['acil', 'm[âa]+temat', 'konu (uygulama|öğrenme)', 'yeni nesil'],
    numberingRestarts: true,
    headerFromLabels: true,
    trimEdgeText: true,
    footerZone: 0.92,
    ignoreGutterLogo: true,
    answerSheetGuard: false,
    namesPerTest: true,
    answerKey: { band: 'bottom' },
  },
  'ucdortbes-start': {
    label: 'ÜçDörtBeş – 0\'dan Başla START Matematik',
    headerFromLabels: true,
    trimEdgeText: true,
    footerZone: 0.92,
    ignoreGutterLogo: true,
    answerSheetGuard: false,
    namesPerTest: true,
    answerKey: { band: 'bottom' },
  },
  ucdortbes: {
    label: 'ÜçDörtBeş – TYT Matematik Soru Bankası',
    topicIgnore: ['^(kolay|orta|zor)', 'konuyu', 'tanımak', 'lazım', 'klasikleşmiş', 'sorular$', 'ösym'],
    headerFromLabels: true,
    trimEdgeText: true,
    footerZone: 0.92,
    ignoreGutterLogo: true,
    answerSheetGuard: false,
    namesPerTest: true,
    answerKey: { band: 'bottom' },
  },
  '3d': {
    label: '3D Yayınları – TYT Matematik Soru Bankası',
    headerFromLabels: true,
    trimEdgeText: true,
    footerZone: 0.92,
    ignoreGutterLogo: true,
    answerSheetGuard: false,
    namesPerTest: true,
    answerKey: { band: 'top' },
  },
  apotemi: {
    label: 'Apotemi – TYT Matematik Soru Bankası',
    leftmostGutter: true,
    headerFromLabels: true,
    trimEdgeText: true,
    footerZone: 0.92,
    ignoreGutterLogo: true,
    answerSheetGuard: false,
    namesPerTest: true,
    answerKey: { band: 'bottom' },
  },
};

/** Settings for a profile name (undefined/'' = defaults); throws on unknown names. */
export const profileOptions = (name) => {
  if (!name) return { ...DEFAULTS };
  const p = PROFILES[name];
  if (!p) throw new Error(`Unknown profile "${name}". Known: ${Object.keys(PROFILES).join(', ')}`);
  return { ...DEFAULTS, ...p };
};
