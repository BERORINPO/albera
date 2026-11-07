# What the v09 mock asks for

**Status:** Draft for discussion with the owner. Nothing here is decided. It sits beside [target-picture-v09.html](target-picture-v09.html), which is built on v08b. `spec/architecture.md` still names v08b as the target picture until the owner chooses.

Each row says what the mock shows, what the product would need, and how much of that exists today.

| # | What the mock shows | Requirement | Today |
|---|---|---|---|
| R1 | Every computer is a camera with its room named (VM, WSL2) | A target shows its isolation at all times | Room lists WSL2 as a level; the wall does not show rooms |
| R2 | A computer with no screen still looks alive | A camera can show recorded commands instead of a picture, from tool events only | Events reach the board; no view draws them |
| R3 | Work handed on runs as a current, with one line saying what and why | Every hand-off from AI to AI is an event with sender, receiver and a reason. No line, no current | Missing: one job has one AI |
| R4 | "Done" stays a claim until another room checks it | Claim and verified are separate states, and only the host can set verified | VM desktop jobs: partly. WSL2: always `agent_reported` |
| R5 | A second room tests the result | A check job takes a result bundle into its own room and reports through the host | Missing |
| R6 | The gate stops only what cannot be undone | The gate is the existing approval: a person, in the approval window | Exists for `task.start` |
| R7 | The ledger holds what AI claimed, what was verified and what you decided | One ledger with three kinds of entry | Two kinds in the mock of v08b; no verified kind |
| R8 | Bero draws who did what | Figures are built from the ledger, and each shows the records it came from | Figures exist in the room |
| R9 | Motion stays quiet until something needs a person | Attention goes to stuck, waiting and failed. The current is short, and reduced motion turns it off | Mock only |
| R10 | Clicking an agent opens what is inside its head | Read-only view per agent: the model and effort, its agent definition file and the rules loaded, the instruction, what fills its context by kind, what it read, what it says it is thinking, and what it cannot see. Stated reasoning is labelled as its own account, and context text is untrusted | Driver sees the stream; no view. Must not expose secrets or the token |
| R11 | Each session has its preview on the canvas, linked to its agent | The page being built appears beside the agent, with the same claim or verified state. The owner reaches it read-only | Missing. A WSL2 sandbox has no network, so a preview needs its own route: a port through the bridge, or a separate preview room built from the result bundle |

## Open questions for the owner

1. Decided by the owner (2026-11-07): each AI shows the name of its configured subagent. Which names are shown comes from settings, not from the product.
2. How many AIs at once should the screen stay readable for?
3. Is a check in a second room always on, or chosen per job? It doubles the run.
4. After "verified", what brings a result into the repository? Today the owner can only read it.
