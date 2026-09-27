// The one sentence the speed test times on each engine (T7): short and
// plain, about 2 s of speech, so timing both engines stays brief. Its own
// module, so the render worker imports it without the page's rendering
// code (and the voice table that comes with it).

export const BENCH_SENTENCE = "The lamp was lit, and the voice began.";
