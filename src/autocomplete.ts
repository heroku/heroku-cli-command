export const completions: Record<string, () => Promise<string[]>> = {
  // Define your custom completions here
  // Example for a command that takes an app name:
  app: async () => {
    // You can implement dynamic completion logic here
    // For example, fetching apps from Heroku API
    return ['app1', 'app2', 'app3']
  },
  // Example for a command that takes a pipeline name:
  pipeline: async () => {
    // Implement pipeline name completion logic
    return ['pipeline1', 'pipeline2']
  },
  // Example for a command that takes a team name:
  team: async () => {
    // Implement team name completion logic
    return ['team1', 'team2']
  },
}

// Export a function to get completions for a specific command
export function getCompletions(command: string): Promise<string[]> | undefined {
  return completions[command]?.()
}
