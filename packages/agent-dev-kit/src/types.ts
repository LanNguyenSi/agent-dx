export interface AgentFeatures {
  memory: boolean;
  triologue: boolean;
  skills: boolean;
}

export interface AgentConfig {
  name: string;
  description: string;
  features: AgentFeatures;
  options: {
    typescript: boolean;
    git: boolean;
    install: boolean;
  };
  metadata: {
    author?: string;
    license?: string;
    repository?: string;
  };
}

export interface TemplateContext {
  agentName: string;
  agentRole: string;
  capabilities: string;
  hasMemory: boolean;
  hasTriologue: boolean;
  hasSkills: boolean;
  hasTypeScript: boolean;
  languageName: string;
  sourceEntry: string;
  testEntry: string;
  memoryBackend: string;
  triologueRoom?: string;
  date: string;
}

export interface GeneratorOptions {
  targetDir: string;
  config: AgentConfig;
  verbose?: boolean;
}
