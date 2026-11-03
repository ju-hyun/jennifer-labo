/**
 * ヘルプポップアップ
 */

export function initHelpSystem() {
  const mainHelpBtn = document.getElementById('mainHelpBtn');
  const contextHelpBtns = document.querySelectorAll('.help-btn-small');

  const openHelpPopup = (sectionId = 'general') => {
    const url = `help.html#${sectionId}`;
    const windowName = 'PerformanceHelpPopup';
    const features = 'width=900,height=850,scrollbars=yes,resizable=yes';

    // Using a global property to maintain the reference across possible re-initializations
    if (window.ptaHelpWindow && !window.ptaHelpWindow.closed) {
      // Update just the hash to trigger internal navigation/scrolling
      window.ptaHelpWindow.location.hash = sectionId;
      window.ptaHelpWindow.focus();
    } else {
      // Open new window and save to global property
      window.ptaHelpWindow = window.open(url, windowName, features);
    }
  };

  if (mainHelpBtn) {
    mainHelpBtn.addEventListener('click', () => openHelpPopup('main-chart'));
  }

  contextHelpBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const sectionId = btn.getAttribute('data-help-section') || 'general';
      openHelpPopup(sectionId);
    });
  });
}
