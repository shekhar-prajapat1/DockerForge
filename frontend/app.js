document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const forgeForm = document.getElementById('forge-form');
  const repoUrlInput = document.getElementById('repo-url');
  const apiKeyInput = document.getElementById('api-key');
  const toggleKeyBtn = document.getElementById('toggle-key-visibility');
  const submitBtn = document.getElementById('submit-btn');
  const submitBtnText = submitBtn.querySelector('.btn-text');
  const submitBtnLoader = submitBtn.querySelector('.loader');
  
  const workstationCard = document.getElementById('workstation-card');
  const agentStatusBadge = document.getElementById('agent-status-badge');
  const statusPulse = document.getElementById('status-pulse');
  const statusText = document.getElementById('status-text');
  const terminalLogs = document.getElementById('terminal-logs');
  const clearTerminalBtn = document.getElementById('clear-terminal');
  
  const resultsCard = document.getElementById('results-card');
  const successPortInfo = document.getElementById('success-port-info');
  const llmExplanation = document.getElementById('llm-explanation');
  const codeDockerfile = document.getElementById('code-dockerfile');
  const codeCompose = document.getElementById('code-compose');
  const copyCodeBtn = document.getElementById('btn-copy-code');
  
  const tabDockerfile = document.getElementById('tab-dockerfile');
  const tabCompose = document.getElementById('tab-compose');
  const codeDockerfileContainer = document.getElementById('code-dockerfile-container');
  const codeComposeContainer = document.getElementById('code-compose-container');
  
  const stepElements = {
    clone: document.getElementById('step-clone'),
    scan: document.getElementById('step-scan'),
    generate: document.getElementById('step-generate'),
    build: document.getElementById('step-build'),
    heal: document.getElementById('step-heal'),
    verify: document.getElementById('step-verify')
  };

  // State
  let eventSource = null;
  let currentActiveStep = null;
  let activeTab = 'dockerfile'; // 'dockerfile' or 'compose'

  // Load API Key from localStorage
  if (localStorage.getItem('gemini_api_key')) {
    apiKeyInput.value = localStorage.getItem('gemini_api_key');
  }

  // Toggle API Key visibility
  toggleKeyBtn.addEventListener('click', () => {
    if (apiKeyInput.type === 'password') {
      apiKeyInput.type = 'text';
      toggleKeyBtn.textContent = '🔒';
    } else {
      apiKeyInput.type = 'password';
      toggleKeyBtn.textContent = '👁️';
    }
  });

  // Clear logs terminal
  clearTerminalBtn.addEventListener('click', () => {
    terminalLogs.innerHTML = '';
  });

  // Code copy to clipboard
  copyCodeBtn.addEventListener('click', () => {
    const textToCopy = activeTab === 'dockerfile' ? codeDockerfile.textContent : codeCompose.textContent;
    navigator.clipboard.writeText(textToCopy).then(() => {
      const originalText = copyCodeBtn.innerHTML;
      copyCodeBtn.innerHTML = '✔️ Copied!';
      setTimeout(() => {
        copyCodeBtn.innerHTML = originalText;
      }, 2000);
    }).catch(err => {
      console.error('Failed to copy: ', err);
    });
  });

  // Tab switching
  [tabDockerfile, tabCompose].forEach(tab => {
    tab.addEventListener('click', (e) => {
      const target = e.target;
      const fileType = target.id === 'tab-dockerfile' ? 'dockerfile' : 'compose';
      activeTab = fileType;
      
      tabDockerfile.classList.remove('active');
      tabCompose.classList.remove('active');
      target.classList.add('active');
      
      if (fileType === 'dockerfile') {
        codeDockerfileContainer.classList.remove('hidden');
        codeComposeContainer.classList.add('hidden');
      } else {
        codeDockerfileContainer.classList.add('hidden');
        codeComposeContainer.classList.remove('hidden');
      }
    });
  });

  // Form Submission
  forgeForm.addEventListener('submit', (e) => {
    e.preventDefault();

    const repoUrl = repoUrlInput.value.trim();
    const apiKey = apiKeyInput.value.trim();

    if (!repoUrl) return;

    // Save API key locally
    if (apiKey) {
      localStorage.setItem('gemini_api_key', apiKey);
    } else {
      localStorage.removeItem('gemini_api_key');
    }

    // Reset UI State
    submitBtn.disabled = true;
    submitBtnText.textContent = 'Forging...';
    submitBtnLoader.classList.remove('hidden');

    workstationCard.classList.remove('hidden');
    resultsCard.classList.add('hidden');
    
    // Clear old steps states
    Object.values(stepElements).forEach(el => {
      el.classList.remove('active', 'completed', 'failed');
    });

    terminalLogs.innerHTML = '';
    appendLog('Connecting to DockerForge SSE orchestrator...', 'system');
    
    updatePulseState('active', 'Working');
    currentActiveStep = null;

    // Scroll to workstation
    workstationCard.scrollIntoView({ behavior: 'smooth' });

    // Establish Server-Sent Events (SSE) stream
    const sseUrl = `/api/forge?repoUrl=${encodeURIComponent(repoUrl)}&apiKey=${encodeURIComponent(apiKey)}`;
    
    if (eventSource) {
      eventSource.close();
    }

    eventSource = new EventSource(sseUrl);

    // 1. Process standard message logs
    eventSource.addEventListener('log', (e) => {
      let data = e.data;
      // Strip outer JSON quotes if returned as a JSON string
      if (data.startsWith('"') && data.endsWith('"')) {
        try {
          data = JSON.parse(data);
        } catch (err) {}
      }
      
      // Determine log category
      let category = 'default';
      if (data.includes('[ERROR]') || data.includes('[CRITICAL FAILURE]')) {
        category = 'error';
      } else if (data.includes('[SUCCESS]')) {
        category = 'success';
      } else if (data.includes('[Agentic Healing]') || data.includes('[WARNING]') || data.includes('[PING WARNING]')) {
        category = 'warning';
      } else if (data.includes('Executing:') || data.includes('docker ')) {
        category = 'command';
      } else if (data.startsWith('===') || data.includes('Initiating')) {
        category = 'system';
      }
      
      appendLog(data, category);
    });

    // 2. Process status step transitions
    eventSource.addEventListener('status', (e) => {
      const { step, message } = JSON.parse(e.data);
      statusText.textContent = message;
      
      // Transition active steps
      if (stepElements[step]) {
        // Complete the previous step if exists
        if (currentActiveStep && stepElements[currentActiveStep]) {
          stepElements[currentActiveStep].classList.remove('active');
          stepElements[currentActiveStep].classList.add('completed');
        }
        
        currentActiveStep = step;
        stepElements[step].classList.add('active');
      }
      
      appendLog(`[STATUS] ${message}`, 'system');
    });

    // 3. Process failure event
    eventSource.addEventListener('error', (e) => {
      const errorData = JSON.parse(e.data || '{}');
      const errorMsg = errorData.message || 'An unexpected error occurred during build validation.';
      
      appendLog(`[FATAL ERROR] ${errorMsg}`, 'error');
      updatePulseState('error', 'Failed');
      
      if (currentActiveStep && stepElements[currentActiveStep]) {
        stepElements[currentActiveStep].classList.remove('active');
        stepElements[currentActiveStep].classList.add('failed');
      }
      
      cleanupSSE();
    });

    // 4. Process pipeline success event
    eventSource.addEventListener('success', (e) => {
      const result = JSON.parse(e.data);
      
      // Mark final step completed
      if (currentActiveStep && stepElements[currentActiveStep]) {
        stepElements[currentActiveStep].classList.remove('active');
        stepElements[currentActiveStep].classList.add('completed');
      }
      
      // Mark all other non-failed steps as completed
      Object.values(stepElements).forEach(el => {
        if (!el.classList.contains('failed')) {
          el.classList.add('completed');
        }
      });
      
      updatePulseState('success', 'Verified');
      appendLog(`[SUCCESS] Dockerfile created, verified and running!`, 'success');

      // Populate results
      successPortInfo.textContent = `The application successfully booted inside the Docker container and responded to local HTTP health checks on mapped host port :${result.hostPort} (Container Port :${result.containerPort}).`;
      
      llmExplanation.innerHTML = formatExplanation(result.explanation);
      codeDockerfile.textContent = result.dockerfile;
      codeCompose.textContent = result.dockerCompose;
      
      // Reveal results card with nice transition
      resultsCard.classList.remove('hidden');
      resultsCard.scrollIntoView({ behavior: 'smooth' });
      
      cleanupSSE();
    });

    // Fallback error handler
    eventSource.onerror = (err) => {
      // EventSource closes silently on server end, check if we already succeeded
      if (statusText.textContent !== 'Verification complete! Dockerfile is fully working.') {
        appendLog('[ERROR] Connection to server stream was lost or aborted.', 'error');
        updatePulseState('error', 'Aborted');
        if (currentActiveStep && stepElements[currentActiveStep]) {
          stepElements[currentActiveStep].classList.remove('active');
          stepElements[currentActiveStep].classList.add('failed');
        }
      }
      cleanupSSE();
    };
  });

  /**
   * Appends logs to terminal.
   * @param {string} text - Log content
   * @param {string} type - Log class type
   */
  function appendLog(text, type = 'default') {
    const line = document.createElement('div');
    line.className = `log-line ${type}`;
    
    // Add date prefix for authentic terminal styling
    const now = new Date();
    const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
    line.textContent = `[${timeStr}] ${text}`;
    
    terminalLogs.appendChild(line);
    terminalLogs.scrollTop = terminalLogs.scrollHeight;
  }

  /**
   * Resets submission states and closes the EventSource.
   */
  function cleanupSSE() {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    submitBtn.disabled = false;
    submitBtnText.textContent = 'Generate & Verify';
    submitBtnLoader.classList.add('hidden');
  }

  /**
   * Updates the live status badge pulse.
   * @param {string} pulseClass - 'active', 'success', 'error', 'gray'
   * @param {string} text - Label text
   */
  function updatePulseState(pulseClass, text) {
    statusPulse.className = `pulse-indicator ${pulseClass}`;
    statusText.textContent = text;
  }

  /**
   * Formats raw markdown explanation from LLM into HTML paragraphs.
   * @param {string} text - Raw text from Gemini
   * @returns {string} HTML content
   */
  function formatExplanation(text) {
    if (!text) return 'No design explanation available.';
    // Standard basic markdown to HTML mapping (paragraphs, lists, and bold strings)
    let html = text
      .replace(/\r\n/g, '\n')
      .replace(/\n\n/g, '</p><p>')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/-\s(.*?)\n/g, '<li>$1</li>');
      
    if (html.includes('<li>')) {
      html = html.replace(/(<li>.*?<\/li>)/gs, '<ul>$1</ul>');
    }
    
    return `<p>${html}</p>`;
  }
});
