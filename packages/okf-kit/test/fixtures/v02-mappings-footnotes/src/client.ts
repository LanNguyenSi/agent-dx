export function send(): void {
  for (let i = 0; i < 3; i++) {
    attempt();
  }
}

function attempt(): void {}
