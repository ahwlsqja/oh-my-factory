// OMF host fixture, "null-error": the null implementation that fails loudly (spec §5.3).
// It exits 1 with no output, whatever it is given. GATE-2 requires every behavior scenario to fail it.
process.exit(1);
