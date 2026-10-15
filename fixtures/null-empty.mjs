// OMF host fixture, "null-empty": the null implementation that succeeds with nothing (spec §5.3).
// It exits 0 with empty stdout, whatever it is given. GATE-2 requires every behavior scenario to fail it.
process.exit(0);
