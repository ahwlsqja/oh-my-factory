// A stand-in for the model, so the example runs offline (spec §13). OMF runs this as the `command`
// reconciler: the prompt arrives on stdin, the answer is JSON on stdout. It always proposes the same
// change; the point of the example is the loop around it, not the proposal.
for await (const _chunk of process.stdin) {
  // Read the whole prompt, so the host never writes into a closed pipe.
}

const candidate = {
  title: "Halve the range at every look in the sorted list search",
  problem:
    "The search reads the sorted list from the first entry and stops when it finds the name, so a name near the end costs about as much as reading the whole list.",
  proposed_outcome:
    "The search looks at the middle entry, keeps only the half that can still hold the name, and repeats until it finds the name or runs out of entries. The answers stay exactly the same.",
  affected_users_systems: "Callers of the search function in the app directory.",
  constraints: "Do not change what the search returns for any name. Keep the change inside the app directory.",
  open_questions: [],
  rationale:
    "The work grows with the length of the list today. Halving the range makes it grow only with how often the list can be halved.",
  affected_paths: ["app/search.mjs"],
};

process.stdout.write(`${JSON.stringify({ candidates: [candidate] })}\n`);
