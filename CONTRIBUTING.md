# Contributing

## Add to the Toolbox

The Toolbox is a small curated list of skills, plugins, integrations and tools that improve an agentic software-development pipeline, shown at [pipelinely.cc/toolbox](https://pipelinely.cc/toolbox). It can be your own work or a useful third-party tool.

To add one, edit [`toolbox/registry.yml`](toolbox/registry.yml), append one entry, and open a PR:

```yaml
  - id: my-tool                  # lowercase-kebab-case, unique
    name: My Tool                # up to 60 characters
    description: One sentence on what it does for the pipeline.   # up to 200 characters
    url: https://github.com/you/my-tool                          # must be https://
    stage: dev                   # planning | dev | code-review | qa
    type: skill                  # tool | skill | plugin | integration
    author: your-github-username # optional
```

Run `npm run validate:toolbox` locally to check your entry against [`toolbox/schema.json`](toolbox/schema.json).

What happens next: CI validates the entry, a maintainer reviews it, and once merged it appears on pipelinely.cc/toolbox automatically.
