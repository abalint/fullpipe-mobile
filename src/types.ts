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
  progress?: number; // 0..1 within the current state, if the worker reports it
  progress_msg?: string | null; // live narration ("pushing card 3/12")
  rating?: number | null; // 1-5 stars from the ledger; null/absent = unrated
  tags?: string[]; // taste tags on the latest review (RATING_TAGS slugs)
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
}

export interface Sentence {
  start: number;
  end?: number;
  tokens: Token[];
}

/** One subtitle cue for the player: a prep-shaped sentence with timing. */
export interface TranscriptSentence {
  idx: number;
  start: number;
  end: number;
  cls?: string; // coverage classification (i_plus_1/…) — absent on old sidecars
  tokens: Token[];
}

/** GET /transcript/{id} — every sentence, unlike prep's i+1 subset. */
export interface TranscriptDoc {
  episode_id: string;
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

/** "k" = I know this (ledger evidence) · "h" = high interest (card priority).
    Unknown needs no mark — candidates are presumed unknown. */
export type TapMark = "k" | "h";

export interface TapBatch {
  episode_id: string;
  batch_id: string;
  taps: [string, TapMark][];
}

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
      review_id: string;
    }
  | { id: string; kind: "enqueue"; source: string };
