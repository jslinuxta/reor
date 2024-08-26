const fs = require("fs");
const https = require("https");
const os = require("os");
const path = require("path");
const AdmZip = require("adm-zip");

// Mapping of OS to binary info
const binariesInfo = {
  darwin: {
    url: "https://github.com/ollama/ollama/releases/download/v0.3.6/ollama-darwin",
    path: "../binaries/darwin/",
    binaryName: "ollama-darwin",
  },
  linux: {
    url: "https://github.com/ollama/ollama/releases/download/v0.3.6/ollama-linux-amd64",
    path: "../binaries/linux/",
    binaryName: "ollama-linux-amd64",
  },
  win32: {
    url: "https://github.com/ollama/ollama/releases/download/v0.3.6/ollama-windows-amd64.zip",
    path: "../binaries/win32/",
    binaryName: "ollama.exe",
  },
};

function ensureDirectoryExistence(filePath) {
  const dirname = path.dirname(filePath);
  if (fs.existsSync(dirname)) {
    return true;
  }
  fs.mkdirSync(dirname, { recursive: true });
}

function setExecutable(filePath) {
  return new Promise((resolve, reject) => {
    fs.chmod(filePath, 0o755, (err) => {
      if (err) reject(err);
      else {
        console.log(`Set ${filePath} as executable`);
        resolve();
      }
    });
  });
}

function downloadAndExtractZip(url, extractPath) {
  return new Promise((resolve, reject) => {
    const tempPath = path.join(os.tmpdir(), 'ollama-temp.zip');
    const file = fs.createWriteStream(tempPath);

    https.get(url, (response) => {
      if (response.statusCode === 200) {
        response.pipe(file);
        file.on('finish', () => {
          file.close(() => {
            console.log('Download completed, extracting...');
            try {
              const zip = new AdmZip(tempPath);
              zip.extractAllTo(extractPath, true);
              fs.unlinkSync(tempPath);
              console.log('Extraction completed');
              resolve();
            } catch (error) {
              reject(new Error(`Failed to extract zip file: ${error.message}`));
            }
          });
        });
      } else if (response.statusCode === 302 || response.statusCode === 301) {
        reject(new Error(`Unexpected redirect: ${response.statusCode} ${response.statusMessage}`));
      } else {
        reject(new Error(`Failed to download: ${response.statusCode} ${response.statusMessage}`));
      }
    }).on('error', (error) => {
      reject(new Error(`Network error during download: ${error.message}`));
    });
  });
}

function downloadFile(url, filePath, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      reject(new Error("Too many redirects"));
      return;
    }

    const file = fs.createWriteStream(filePath);
    let fileStream = null;

    const cleanupAndReject = (error) => {
      if (fileStream) fileStream.close();
      fs.unlink(filePath, (unlinkError) => {
        if (unlinkError) {
          console.error(`Failed to delete incomplete file ${filePath}: ${unlinkError.message}`);
        }
        reject(error);
      });
    };

    https.get(url, (response) => {
      if (response.statusCode === 200) {
        fileStream = response.pipe(file);
        fileStream.on("finish", () => {
          fileStream.close(() => {
            console.log(`Downloaded to ${filePath}`);
            resolve();
          });
        });
      } else if (response.statusCode === 302 || response.statusCode === 301) {
        file.close(() => {
          fs.unlink(filePath, (unlinkError) => {
            if (unlinkError) {
              console.error(`Failed to delete redirect file ${filePath}: ${unlinkError.message}`);
            }
            console.log(`Following redirect to: ${response.headers.location}`);
            downloadFile(response.headers.location, filePath, redirectCount + 1)
              .then(resolve)
              .catch(reject);
          });
        });
      } else {
        cleanupAndReject(new Error(`Failed to download: ${response.statusCode} ${response.statusMessage}`));
      }
    }).on("error", (error) => {
      cleanupAndReject(new Error(`Network error during download: ${error.message}`));
    });

    file.on("error", (error) => {
      cleanupAndReject(new Error(`File system error: ${error.message}`));
    });
  });
}

async function downloadIfMissing(platformKey) {
  const info = binariesInfo[platformKey];
  const directoryPath = path.join(__dirname, info.path);
  ensureDirectoryExistence(directoryPath);
  console.log("Checking", platformKey, "binary in", directoryPath);
  const filePath = path.join(directoryPath, info.binaryName);

  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    console.log(`${platformKey} binary already exists`);
    if (platformKey !== "win32") {
      await setExecutable(filePath);
    }
  } catch (err) {
    console.log(`${platformKey} binary not found, downloading...`);
    try {
      if (platformKey === 'win32') {
        await downloadAndExtractZip(info.url, directoryPath);
        console.log('Windows binary downloaded and extracted');
      } else {
        await downloadFile(info.url, filePath);
        if (platformKey !== "win32") {
          await setExecutable(filePath);
        }
      }
    } catch (error) {
      console.error(`Error processing ${platformKey} binary:`, error.message);
      throw error; // Re-throw the error to be caught by the caller
    }
  }
}

async function main() {
  const platform = os.platform();
  try {
    if (process.argv[2] === "all") {
      await Promise.all(Object.keys(binariesInfo).map(downloadIfMissing));
    } else {
      await downloadIfMissing(platform);
    }
    console.log("All operations completed successfully");
  } catch (error) {
    console.error("An error occurred during the process:", error.message);
    process.exit(1); // Exit with an error code
  }
}

main();