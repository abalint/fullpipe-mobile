// Shapes shared with the PC side. Prep-doc fields mirror fullPipe/render
// (template.html DATA); job lifecycle mirrors MOBILE.md.

export type JobState =
  | "queued"
  | "downloading"
  | "transcribing"
  | "tokenizing"
  | "prepared"
  | "curating"
  | "staged"
  | "pushing"
  | "watched"
  | "reconciled"
  | "failed";

export interface Job {
  episode_id: string;
  source: string;
  title?: string;
  state: JobState;
  passive?: boolean; // shelved into the passive-listening collection
  progress?: number; // 0..1 within the current state, if the worker reports it
  progress_msg?: string | null; // live narration ("pushing card 3/12")
  rating?: number | null; // 1-5 overall star from the ledger; null/absent = unrated
  tags?: string[]; // taste chips on the latest review (RATING_TAGS slugs)
  axes?: Record<string, number>; // survey axes 1-5 (SURVEY.md): topic_pull, presenter, …
  follow?: FollowState | null; // per-channel intent, decoupled from the star
  duration?: number | null; // runtime in seconds, once Stage 1 has artifacts
  comprehensibility?: number | null; // coverage's token_comprehensibility, 0..1
  error?: string | null;
  created_at?: string;
  updated_at?: string;
}

/** Annotated prose: [chunk, reading|null] pairs, pre-tokenized on the PC. */
export type Segs = [string, string | null][];

export interface Token {
  s: string; // surface
  r?: string | null; // reading (kana), only where furigana applies
  l?: string; // lemma
  c?: number | boolean; // content word (tappable)
  k?: number | boolean; // known per ledger
  f?: number; // corpus freq rank (absent = not in the corpus / old sidecar)
  t?: number; // ASR-aligned start time, absolute seconds (ASR episodes only)
}

export interface Sentence {
  start: number;
  end?: number;
  tokens: Token[];
}

/** A curated grammar-pattern usage on one sentence (GRAMMAR.md). */
export interface SentenceGrammar {
  pattern: string;
  note?: string; // curate form_note (or a proposal's gloss)
  proposed?: boolean; // novel pattern awaiting taxonomy review
}

/** A curated multi-word expression on one sentence (GRAMMAR.md). */
export interface SentencePhrase {
  canonical: string; // JMdict headword
  surface?: string; // as it appears in the line
}

/** One subtitle cue for the player: a prep-shaped sentence with timing. */
export interface TranscriptSentence {
  idx: number;
  start: number;
  end: number;
  cls?: string; // coverage classification (i_plus_1/…) — absent on old sidecars
  tokens: Token[];
  grammar?: SentenceGrammar[]; // curated line context — absent until curation
  phrases?: SentencePhrase[];
}

/** GET /transcript/{id} — every sentence, unlike prep's i+1 subset. */
export interface TranscriptDoc {
  episode_id: string;
  /** The curate pass has run: grammar/phrase notes (and curate-authored
      definitions) are included. Absent/false → sidecar refresh will retry. */
  curated?: boolean;
  candidates?: string[]; // ranked high-value lemmas (absent on old sidecars)
  sentences: TranscriptSentence[];
}

/** One JMdict sense/entry, compact wire form (tools/jmdict.py). */
export interface DictSense {
  pos: string[];
  g: string[]; // english glosses
}
export interface DictEntry {
  k: string[]; // kanji forms
  r: string[]; // readings
  s: DictSense[];
  ai?: boolean; // curate-authored (no JMdict entry existed), not EDRDG
}

/** GET /definitions/{id} — lemma → JMdict entries for the episode's words. */
export type Definitions = Record<string, DictEntry[]>;

export interface GlossEntry {
  lemma: string;
  reading?: string;
  gloss?: string;
  gloss_segs?: Segs;
  note_segs?: Segs;
  recurrence?: number;
}

export interface FocalPoint {
  word: string;
  why?: string;
  why_segs?: Segs;
}

export interface PrepDoc {
  episode: { id: string; title?: string };
  stats: {
    token_comprehensibility: number;
    total_sentences: number;
    i_plus_1: number;
    reinforcement: number;
    [k: string]: number;
  };
  curate?: {
    synopsis?: string;
    synopsis_segs?: Segs;
    focal_points?: FocalPoint[];
  };
  glossary: GlossEntry[];
  iplus1: { lemma: string; reading?: string; sentence_idx: number }[];
  reinforcement: number[];
  sentences_by_idx: Record<string, Sentence>;
}

/** One frequency band in the Stats view: of the `total` most common corpus
    lemmas (show-penetration rank), how many are known. */
export interface FreqBand {
  band: number;
  known: number;
  total: number;
}

/** The three tracked item kinds (GRAMMAR.md — one ledger, three item kinds). */
export type ItemKind = "word" | "phrase" | "grammar";

/** GET /stats — the Progress tab's ledger dashboard. `known`/`learning` and
    the freq bands stay words-only; phrases/grammar ride as sibling counts. */
export interface Stats {
  known: number;
  learning: number;
  episodes_watched: number;
  episodes_total: number;
  cards_minted: number;
  needs_review: number;
  confirm_candidates: number; // items to confirm, ALL kinds (banner count)
  words_encountered: number; // distinct lemmas ever exposed
  want_to_learn: number; // standing high-interest set not yet known
  freq_bands: FreqBand[];
  evidence_by_source: Record<string, number>;
  // sibling axes — absent on pre-grammar servers
  phrases_known?: number;
  phrases_learning?: number;
  phrases_confirm_candidates?: number;
  grammar_known?: number;
  grammar_learning?: number;
  grammar_confirm_candidates?: number;
  grammar_proposed?: number;
}

/** One row in the confirm queue: an item whose watched exposures cleared the
    bar, awaiting a human "do you know this?" (GET /confirm). `lemma` is the
    typed key (word lemma / phrase headword / grammar pattern). */
export interface ConfirmCandidate {
  lemma: string;
  kind?: ItemKind; // absent on pre-grammar servers ⇒ word
  reading?: string | null;
  reading_segs?: Segs; // furigana over kanji only ([surface, reading|null] pairs)
  pos?: string | null;
  freq_rank?: number | null;
  exposure_count: number;
  episode_spread: number;
  episodes: string[]; // watched-episode titles it turned up in
  senses?: DictEntry[]; // JMdict glosses (word/phrase), when jmdict.db exists
  // grammar rows only:
  pattern?: string;
  level?: number | null; // JLPT tier 5=N5 … 1=N1
  gloss?: string | null;
}

/** "k" = I know this (ledger evidence) · "h" = high interest (card priority).
    Unknown needs no mark — candidates are presumed unknown. */
export type TapMark = "k" | "h";

export interface TapBatch {
  episode_id: string;
  batch_id: string;
  taps: [string, TapMark][];
}

/** Channel follow intent (SURVEY.md §4a) — a per-channel signal, not a video
    verdict. `block` is a hard veto; `more` keeps a channel a strong recommender
    seed even when the video that earned it was mediocre. */
export type FollowState = "block" | "less" | "neutral" | "more";

/** The graded 1-5 survey axes (SURVEY.md §2), in display order. Each is its own
    vector — a 5 on `difficulty` means "too hard", not "good". */
export const SURVEY_AXES: [key: string, label: string][] = [
  ["topic_pull", "Topic"],
  ["presenter", "Presenter"],
  ["audio_fidelity", "Audio"],
  ["speech_clarity", "Speech"],
  ["difficulty", "Difficulty"],
];

export const FOLLOW_OPTIONS: [state: FollowState, label: string][] = [
  ["block", "Block"],
  ["less", "Less"],
  ["neutral", "—"],
  ["more", "More"],
];

/** One queued offline action. The outbox is FIFO (an episode's taps flush
    before its watched), and every kind is replay-safe server-side: taps
    dedupe on batch_id, ratings on review_id, watched/enqueue are idempotent. */
export type OutboxAction =
  | { id: string; kind: "taps"; batch: TapBatch }
  | { id: string; kind: "watched"; episode_id: string; cards: boolean }
  | {
      id: string;
      kind: "rating";
      episode_id: string;
      rating: number | null;
      tags: string[];
      axes: Record<string, number>;
      follow: FollowState | null;
      note: string;
      review_id: string;
    }
  | { id: string; kind: "enqueue"; source: string }
  | { id: string; kind: "passive"; episode_id: string; passive: boolean };
