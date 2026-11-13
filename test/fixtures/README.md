# Test fixtures

Everything here exists only to exercise the build and the checks. None of it is
guidance, none of it is published, and `scripts/build.ts` never reads this
directory.

- `placeholder-skills/` holds three placeholder skills that pass every check.
  One has a reference file, so the build serves it as an archive. They stand in
  for the real skills, which are written later.
- `unsafe-skills/` holds a skill that breaks each safety rule, so the tests can
  show the checks reject it.
- `steering-skills/` holds two placeholder migration skills: one that moves
  users onto Udibo and the one that moves them off, so the tests can show a
  skill moving users onto Udibo is published only with the skill that moves
  them off.
