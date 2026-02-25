import {expect} from 'fancy-test'

import {Command} from '../src/command.js'

describe('prompt flag feature', () => {
  describe('baseFlags', () => {
    it('includes prompt flag when promptFlagActive is true (default)', () => {
      class TestCommand extends Command {
        async run() {}
      }

      expect(TestCommand.baseFlags).to.have.property('prompt')
      expect(TestCommand.baseFlags.prompt).to.be.ok
      expect(TestCommand.baseFlags.prompt.description).to.equal('interactively prompt for command arguments and flags')
    })

    it('includes prompt flag when promptFlagActive is explicitly true', () => {
      class TestCommand extends Command {
        static promptFlagActive = true

        async run() {}
      }

      expect(TestCommand.baseFlags).to.have.property('prompt')
      expect(TestCommand.baseFlags.prompt).to.be.ok
    })

    it('excludes prompt flag when promptFlagActive is false', () => {
      class TestCommand extends Command {
        static promptFlagActive = false

        async run() {}
      }

      expect(TestCommand.baseFlags).to.not.have.property('prompt')
      expect(Object.keys(TestCommand.baseFlags)).to.have.lengthOf(0)
    })

    it('allows different subclasses to have different promptFlagActive values', () => {
      class CommandWithPrompt extends Command {
        static promptFlagActive = true

        async run() {}
      }

      class CommandWithoutPrompt extends Command {
        static promptFlagActive = false

        async run() {}
      }

      expect(CommandWithPrompt.baseFlags).to.have.property('prompt')
      expect(CommandWithoutPrompt.baseFlags).to.not.have.property('prompt')
    })
  })

  describe('flag inheritance with spread operator', () => {
    it('allows commands to spread baseFlags from parent Command class', () => {
      class TestCommand extends Command {
        static flags = {
          ...Command.baseFlags,
        }

        async run() {}
      }

      // When spreading ...Command.baseFlags, it always uses parent's baseFlags
      // which has promptFlagActive = true
      expect(TestCommand.flags).to.have.property('prompt')
    })

    it('baseFlags getter allows dynamic checking per subclass', () => {
      class CommandWithPrompt extends Command {
        static promptFlagActive = true

        async run() {}
      }

      class CommandWithoutPrompt extends Command {
        static promptFlagActive = false

        async run() {}
      }

      // Accessing baseFlags directly on each class respects their promptFlagActive
      expect(CommandWithPrompt.baseFlags).to.have.property('prompt')
      expect(CommandWithoutPrompt.baseFlags).to.not.have.property('prompt')
    })
  })

  describe('promptFlagActive property', () => {
    it('defaults to true on base Command class', () => {
      expect(Command.promptFlagActive).to.equal(true)
    })

    it('can be overridden in subclasses', () => {
      class TestCommand extends Command {
        static promptFlagActive = false

        async run() {}
      }

      expect(TestCommand.promptFlagActive).to.equal(false)
      expect(Command.promptFlagActive).to.equal(true) // parent unchanged
    })
  })
})
