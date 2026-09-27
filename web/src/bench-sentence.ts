// The one sentence the speed test times on each engine (T7): plain, about
// 4 s of speech. Long enough that a graphics chip's fixed cost per call does
// not decide the race: with a 2 s sentence this laptop's Intel graphics
// measured 0.92x one time and 1.3x the next against its processor's 1.1x.
// Its own module, so the render worker imports it without the page's
// rendering code (and the voice table that comes with it).

export const BENCH_SENTENCE = "The lamp was lit, and the voice began to read the first page aloud.";
