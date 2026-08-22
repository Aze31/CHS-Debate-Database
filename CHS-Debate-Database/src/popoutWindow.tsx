import React, { useEffect, useState, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface PopoutWindowProps {
  children: ReactNode;
  title?: string;
  onClose: () => void;
}

export const PopoutWindow: React.FC<PopoutWindowProps> = ({ 
  children, 
  title = 'New Window', 
  onClose 
}) => {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const newWindowRef = useRef<Window | null>(null);

  useEffect(() => {
    // 1. Create a container element inside the host window
    const div = document.createElement('div');
    setContainer(div);

    // 2. Open a new blank browser window
    const newWindow = window.open(
      '', 
      '_blank', 
      'width=800,height=600,left=200,top=200,resizable=yes,scrollbars=yes'
    );

    if (!newWindow) {
      alert('Popup blocked! Please allow popups for this site.');
      return;
    }

    newWindowRef.current = newWindow;
    newWindow.document.title = title;
    
    // 3. Append the react container to the new window's body
    newWindow.document.body.appendChild(div);

    // 4. Copy existing stylesheets from the parent window so styles apply
    Array.from(document.styleSheets).forEach((styleSheet) => {
      try {
        if (styleSheet.href) {
          const link = document.createElement('link');
          link.rel = 'stylesheet';
          link.href = styleSheet.href;
          newWindow.document.head.appendChild(link);
        } else if (styleSheet.cssRules) {
          const style = document.createElement('style');
          Array.from(styleSheet.cssRules).forEach((rule) => {
            style.appendChild(document.createTextNode(rule.cssText));
          });
          newWindow.document.head.appendChild(style);
        }
      } catch (e) {
        // Avoid Cross-Origin Errors for external stylesheets
        console.warn('Could not copy stylesheet rules', e);
      }
    });

    // 5. Monitor when user closes the popup window directly via window [X]
    const checkWindowClosed = setInterval(() => {
      if (newWindow.closed) {
        clearInterval(checkWindowClosed);
        onClose();
      }
    }, 500);

    // Cleanup on unmount
    return () => {
      clearInterval(checkWindowClosed);
      if (newWindowRef.current && !newWindowRef.current.closed) {
        newWindowRef.current.close();
      }
    };
  }, [title, onClose]);

  // Render children into the new window's container element using a portal
  return container ? createPortal(children, container) : null;
};
