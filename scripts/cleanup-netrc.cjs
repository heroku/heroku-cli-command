const fs = require('fs')
const os = require('os')
const path = require('path')
/**
 * List of Heroku machines to remove from the .netrc file
 * as they are no longer used and pose a security risk.
 *
 * Add any additional Heroku machines to this list that you
 *  want to remove from the .netrc file.
 */
const machinesToRemove = ['api.heroku.com', 'git.heroku.com', 'api.staging.herokudev.com']
/**
 * Removes the unencrypted Heroku entries from the .netrc file
 * This is a mitigation for a critical security vulnerability
 * where unencrypted Heroku API tokens could be leaked
 * if the .netrc file is compromised. This function removes
 * any entries related to Heroku from the .netrc file as Heroku
 * has discontinued it's use.
 *
 * BE ADVISED: a defect exists in the original implementation
 * where orphaned credentials (passwords without machine blocks)
 * are created when attempting to delete machine entries using the
 * netrc-parser library.
 *
 * This implementation corrects that issue by removing orphaned
 * credentials as well.
 *
 * @returns {void}
 */
function removeUnencryptedNetrcMachines() {
  try {
    const netrcPath = getNetrcFileLocation()

    if (!fs.existsSync(netrcPath)) {
      console.log('.netrc file not found, nothing to clean up')
      return
    }

    const content = fs.readFileSync(netrcPath, 'utf8')
    const lines = content.split('\n')
    const filteredLines = []
    let skipLines = false

    // Iterate through lines, handling machine blocks and orphaned credentials
    for (const line of lines) {
      const trimmedLine = line.trim().toLowerCase()

      // Check if we're starting a Heroku machine block
      if (trimmedLine.startsWith('machine') &&
        (machinesToRemove.some(machine => trimmedLine.includes(machine)))) {
        skipLines = true
        continue
      }

      // Check if we're starting a new machine block (non-Heroku)
      if (trimmedLine.startsWith('machine') && !skipLines) {
        skipLines = false
      }

      // Check for orphaned Heroku passwords (HKRU-) and their associated usernames
      if (/(HRKUSTG-|HKRU-)/.test(line)) {
        // Remove the previous line if it exists (username)
        if (filteredLines.length > 0) {
          filteredLines.pop()
        }

        continue
      }

      // Only keep lines if we're not in a Heroku block
      if (!skipLines) {
        filteredLines.push(line)
      }
    }

    // Remove any trailing empty lines
    while (filteredLines.length > 0 && !filteredLines[filteredLines.length - 1].trim()) {
      filteredLines.pop()
    }

    // Add a newline at the end if we have content
    const outputContent = filteredLines.length > 0 ?
      filteredLines.join('\n') + '\n' :
      ''

    fs.writeFileSync(netrcPath, outputContent)
  } catch (error) {
    throw new Error(`Error cleaning up .netrc: ${error.message}`)
  }
}

/**
 * Finds the absolute path to the .netrc file
 * on disk based on the operating system. This
 * code was copied directly from `netrc-parser`
 * and optimized for use here.
 *
 * @see [netrc-parser](https://github.com/jdx/node-netrc-parser/blob/master/src/netrc.ts#L177)
 *
 * @returns {string} the file path of the .netrc on disk.
 */
function getNetrcFileLocation() {
  let home = ''
  if (os.platform() === 'win32') {
    home =
      process.env.HOME ??
      (process.env.HOMEDRIVE && process.env.HOMEPATH && path.join(process.env.HOMEDRIVE, process.env.HOMEPATH)) ??
      process.env.USERPROFILE
  }

  if (!home) {
    home = os.homedir() ?? os.tmpdir()
  }

  return path.join(home, os.platform() === 'win32' ? '_netrc' : '.netrc')
}

removeUnencryptedNetrcMachines()
