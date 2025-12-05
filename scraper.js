const puppeteer = require('puppeteer');
const fs = require('fs');

// Default configuration
const DEFAULT_CONFIG = {
  searchQuery: 'TRADING',
  maxProducts: 100,
  scrollDelay: 3000, // Increased delay to allow more time for content to load
  maxScrollAttempts: 100, // Increased attempts to get more products
  headless: true, // Set to false to see the browser
  debug: false, // Set to true to save screenshots and extra logging
};

// Logging utility
function log(level, message) {
  const timestamp = new Date().toLocaleTimeString();
  const prefix = {
    info: '[INFO]',
    success: '[SUCCESS]',
    warning: '[WARNING]',
    error: '[ERROR]',
  }[level] || '[LOG]';
  console.log(`[${timestamp}] ${prefix} ${message}`);
}

// Whop's social handles to filter out
const WHOP_HANDLES = ['whopio', 'whophq', 'whop', 'whopcom', 'whop_io', 'whop_hq'];

function isWhopSocialLink(url) {
  const lowerUrl = url.toLowerCase();
  return WHOP_HANDLES.some(handle => 
    lowerUrl.includes(`/${handle}`) || 
    lowerUrl.includes(`@${handle}`)
  );
}

// Extract products from search page
async function scrapeSearchResults(page, searchQuery, maxProducts, scrollDelay, maxScrollAttempts, config = {}) {
  log('info', `Starting search for: "${searchQuery}"`);
  
  const searchUrl = `https://whop.com/discover/search/?q=${encodeURIComponent(searchQuery)}`;
  
  // Set up request interception to monitor API calls
  let requestCount = 0;
  let responseCount = 0;
  
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('api') || url.includes('graphql') || url.includes('search')) {
      requestCount++;
    }
  });
  
  page.on('response', (response) => {
    const url = response.url();
    if (url.includes('api') || url.includes('graphql') || url.includes('search')) {
      responseCount++;
    }
  });
  
  // Navigate with longer timeout and wait for content
  await page.goto(searchUrl, { 
    waitUntil: 'networkidle0', 
    timeout: 60000 
  });
  
  // Wait longer for JavaScript to load products dynamically
  await new Promise(resolve => setTimeout(resolve, 5000));
  
  // Try to wait for product cards or content to appear
  try {
    await page.waitForSelector('a[href*="/discover/"]:not([href*="/search"])', { timeout: 10000 });
    log('info', 'Product links detected on page');
  } catch (e) {
    log('warning', 'No product links found in initial load, will continue scanning');
  }
  
  // Check if page loaded correctly
  const pageTitle = await page.title();
  log('info', `Page title: ${pageTitle}`);
  
  // Check for potential blocking
  const pageContent = await page.content();
  const pageText = await page.evaluate(() => document.body.innerText);
  
  if (pageContent.includes('blocked') || pageContent.includes('captcha') || pageContent.includes('Cloudflare')) {
    log('warning', 'Possible blocking detected on page');
  }
  
  // Debug: Save screenshot if debug mode is enabled
  if (config.debug) {
    await page.screenshot({ path: `debug-search-page-${Date.now()}.png`, fullPage: true });
    log('info', 'Debug screenshot saved');
  }
  
  // Log page info for debugging
  const linkCount = await page.evaluate(() => {
    return {
      totalLinks: document.querySelectorAll('a').length,
      discoverLinks: document.querySelectorAll('a[href*="/discover/"]').length,
      bodyText: document.body.innerText.substring(0, 500),
    };
  });
  
  log('info', `Page stats: ${linkCount.totalLinks} total links, ${linkCount.discoverLinks} /discover/ links`);
  
  if (linkCount.discoverLinks === 0) {
    log('warning', 'No /discover/ links found on page. Page content preview:');
    log('warning', linkCount.bodyText.substring(0, 200));
  } else {
    // Debug: Log sample hrefs to understand the structure
    const sampleHrefs = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href*="/discover/"]'));
      return links.slice(0, 10).map(link => link.getAttribute('href'));
    });
    log('info', `Sample /discover/ hrefs: ${sampleHrefs.slice(0, 5).join(', ')}`);
  }
  
  // Try multiple selectors to find products
  log('info', 'Scanning for product links...');
  
  // Set up MutationObserver to watch for new products being added to DOM
  await page.evaluate(() => {
    window.detectedProducts = new Set();
    window.mutationObserverActive = true;
    
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === 1) { // Element node
            // Check if the node itself is a link
            if (node.tagName === 'A' && node.href) {
              const href = node.getAttribute('href') || node.href;
              if (href && href.includes('/discover/') && !href.includes('/search')) {
                window.detectedProducts.add(href);
              }
            }
            
            // Check for links within the node
            const links = node.querySelectorAll?.('a[href*="/discover/"]');
            if (links) {
              links.forEach(link => {
                const href = link.getAttribute('href') || link.href;
                if (href && !href.includes('/discover/search') && !href.includes('/search?')) {
                  window.detectedProducts.add(href);
                }
              });
            }
          }
        });
      });
    });
    
    // Observe the entire document for changes
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
    
    window.mutationObserver = observer;
    console.log('MutationObserver set up to watch for new products');
  });
  
  let products = new Set();
  
  // Extract initial products
  {
    // Extract current products with multiple strategies
    const currentProducts = await page.evaluate(() => {
      const productUrls = [];
      const seenUrls = new Set();
      
      // Strategy 1: Look for links with /discover/ pattern, but exclude search links
      const links = Array.from(document.querySelectorAll('a[href*="/discover/"]'));
      
      // Debug: Log sample hrefs to understand structure
      if (links.length > 0) {
        const sampleHrefs = links.slice(0, 10).map(l => l.getAttribute('href'));
        console.log('Sample hrefs found:', sampleHrefs);
      }
      
      for (const link of links) {
        let href = link.getAttribute('href');
        if (!href) continue;
        
        // Skip search links explicitly
        if (href.includes('/discover/search') || href.includes('/search?')) {
          continue;
        }
        
        // Handle relative URLs
        if (href.startsWith('/')) {
          href = `https://whop.com${href}`;
        } else if (!href.startsWith('http')) {
          // Skip if it's not a valid URL
          continue;
        }
        
        // Clean up the URL - remove query params and fragments for matching
        const cleanHref = href.split('?')[0].split('#')[0];
        
        // Match pattern: /discover/company/product (two segments after /discover/)
        // Must have exactly two segments after /discover/ and not be a search page
        const match = cleanHref.match(/^https?:\/\/[^\/]+\/discover\/([^\/]+)\/([^\/]+)\/?$/);
        
        if (match) {
          // Double check it's not a search page
          if (!cleanHref.includes('/search')) {
            // Normalize URL
            const normalizedUrl = cleanHref.endsWith('/') ? cleanHref.slice(0, -1) : cleanHref;
            
            if (!seenUrls.has(normalizedUrl)) {
              seenUrls.add(normalizedUrl);
              productUrls.push(normalizedUrl);
            }
          }
        }
      }
      
      // Strategy 2: Look for product cards/containers that might have links
      // Products might be in cards, grids, or specific containers
      if (productUrls.length === 0) {
        // Look for common product container patterns
        const productContainers = document.querySelectorAll('[class*="card"], [class*="product"], [class*="item"], [data-testid*="product"]');
        
        for (const container of productContainers) {
          const link = container.querySelector('a[href]');
          if (link) {
            let href = link.getAttribute('href');
            if (!href) continue;
            
            // Skip search links
            if (href.includes('/discover/search') || href.includes('/search?')) {
              continue;
            }
            
            // Handle relative URLs
            if (href.startsWith('/discover/') && !href.startsWith('/discover/search')) {
              href = `https://whop.com${href}`;
            } else if (!href.startsWith('http')) {
              continue;
            }
            
            const cleanHref = href.split('?')[0].split('#')[0];
            
            // Check if it matches product pattern
            const productMatch = cleanHref.match(/\/discover\/([^\/]+)\/([^\/]+)\/?$/);
            if (productMatch && 
                productMatch[1] !== 'search' && 
                productMatch[2] !== 'search' &&
                !cleanHref.includes('/search')) {
              
              const normalizedUrl = cleanHref.endsWith('/') ? cleanHref.slice(0, -1) : cleanHref;
              
              if (!seenUrls.has(normalizedUrl)) {
                seenUrls.add(normalizedUrl);
                productUrls.push(normalizedUrl);
              }
            }
          }
        }
      }
      
      // Strategy 3: Look through all links more carefully
      if (productUrls.length === 0) {
        const allLinks = Array.from(document.querySelectorAll('a[href]'));
        for (const link of allLinks) {
          let href = link.getAttribute('href');
          if (!href) continue;
          
          // Skip search links
          if (href.includes('/discover/search') || href.includes('/search?') || href.includes('category=')) {
            continue;
          }
          
          // Must be a /discover/ link but not search
          if (!href.includes('/discover/') || href.includes('/search')) {
            continue;
          }
          
          // Handle relative URLs
          if (href.startsWith('/discover/') && !href.startsWith('/discover/search')) {
            href = `https://whop.com${href}`;
          } else if (!href.startsWith('http')) {
            continue;
          }
          
          const cleanHref = href.split('?')[0].split('#')[0];
          
          // Check if it matches product pattern: /discover/X/Y
          const productMatch = cleanHref.match(/\/discover\/([^\/]+)\/([^\/]+)\/?$/);
          if (productMatch && 
              productMatch[1] !== 'search' && 
              productMatch[2] !== 'search' &&
              !cleanHref.includes('/search')) {
            
            const normalizedUrl = cleanHref.endsWith('/') ? cleanHref.slice(0, -1) : cleanHref;
            
            if (!seenUrls.has(normalizedUrl)) {
              seenUrls.add(normalizedUrl);
              productUrls.push(normalizedUrl);
            }
          }
        }
      }
      
      // Debug: Log what we found
      console.log(`Found ${productUrls.length} product URLs in initial scan`);
      if (productUrls.length > 0) {
        console.log('Sample product URLs:', productUrls.slice(0, 5));
      }
      
      return productUrls;
    });
    
    currentProducts.forEach(url => products.add(url));
    
    const initialProductCount = currentProducts.length;
    log('info', `Initial scan: Found ${initialProductCount} products`);
    
    // If we found products, log some samples
    if (currentProducts.length > 0) {
      log('info', `Sample product URLs: ${currentProducts.slice(0, 3).join(', ')}`);
    }
    
    // Now wait for API responses and DOM changes instead of just scrolling
    log('info', 'Starting to load more products by waiting for API responses and DOM changes...');
    
    // Helper function to extract products from page
    const extractProducts = async () => {
      return await page.evaluate(() => {
        const productUrls = [];
        const seenUrls = new Set();
        
        const links = Array.from(document.querySelectorAll('a[href*="/discover/"]'));
        
        for (const link of links) {
          let href = link.getAttribute('href');
          if (!href) continue;
          
          if (href.includes('/discover/search') || href.includes('/search?')) {
            continue;
          }
          
          if (href.startsWith('/')) {
            href = `https://whop.com${href}`;
          } else if (!href.startsWith('http')) {
            continue;
          }
          
          const cleanHref = href.split('?')[0].split('#')[0];
          const match = cleanHref.match(/^https?:\/\/[^\/]+\/discover\/([^\/]+)\/([^\/]+)\/?$/);
          
          if (match && !cleanHref.includes('/search')) {
            const normalizedUrl = cleanHref.endsWith('/') ? cleanHref.slice(0, -1) : cleanHref;
            if (!seenUrls.has(normalizedUrl)) {
              seenUrls.add(normalizedUrl);
              productUrls.push(normalizedUrl);
            }
          }
        }
        
        return productUrls;
      });
    };
    
    // Helper function to get current product count from DOM
    const getProductCountFromDOM = async () => {
      return await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a[href*="/discover/"]'));
        const productUrls = new Set();
        for (const link of links) {
          let href = link.getAttribute('href');
          if (!href || href.includes('/discover/search') || href.includes('/search?')) continue;
          if (href.startsWith('/')) href = `https://whop.com${href}`;
          if (!href.startsWith('http')) continue;
          const cleanHref = href.split('?')[0].split('#')[0];
          const match = cleanHref.match(/^https?:\/\/[^\/]+\/discover\/([^\/]+)\/([^\/]+)\/?$/);
          if (match && !cleanHref.includes('/search')) {
            productUrls.add(cleanHref.endsWith('/') ? cleanHref.slice(0, -1) : cleanHref);
          }
        }
        return productUrls.size;
      });
    };
    
    let previousProductCount = products.size;
    let scrollAttempts = 0;
    const maxScrollAttempts = 20; // Reduced since we're waiting properly
    let noNewContentCount = 0;
    
    log('info', `Initial products: ${previousProductCount}`);
    
    // Identify the specific API endpoint that loads products
    const apiPatterns = new Set();
    let detectedApiEndpoint = null;
    const apiResponseListener = async (response) => {
      const url = response.url();
      if ((url.includes('segapi.whop.com') || url.includes('api') || url.includes('graphql') || url.includes('search') || url.includes('discover')) && 
          response.status() === 200) {
        // Log API patterns to identify the one that loads products
        if (!apiPatterns.has(url)) {
          apiPatterns.add(url);
          log('info', `Detected API endpoint: ${url.substring(0, 200)}...`);
        }
        // Track the specific segapi endpoint
        if (!detectedApiEndpoint && url.includes('segapi.whop.com')) {
          detectedApiEndpoint = url;
          log('info', `Detected product API endpoint: ${url.substring(0, 200)}...`);
        }
      }
    };
    
    page.on('response', apiResponseListener);
    
    // Wait a bit to capture initial API patterns
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Scroll loop - wait for the specific API endpoint with natural scrolling
    while (scrollAttempts < maxScrollAttempts) {
      // Check if we've already reached the maximum products before starting another scroll attempt
      if (products.size >= maxProducts) {
        log('info', `Already have ${products.size} products (max: ${maxProducts}), stopping scroll`);
        break;
      }
      
      scrollAttempts++;
      
      log('info', `Attempt ${scrollAttempts}: Current products: ${previousProductCount}/${maxProducts}`);
      
      // Get current product count from DOM before scrolling
      const currentProductCountInDOM = await getProductCountFromDOM();
      
      // Increase wait times if we haven't reached maxProducts yet (to handle lag)
      const needsMoreProducts = previousProductCount < maxProducts;
      const mouseMoveWait = needsMoreProducts ? 400 + Math.random() * 400 : 200 + Math.random() * 300;
      const mouseWheelWait = needsMoreProducts ? 600 + Math.random() * 600 : 300 + Math.random() * 400;
      const apiTimeout = needsMoreProducts ? 20000 : 15000; // 20s vs 15s
      const domUpdateWait = needsMoreProducts ? 2000 + Math.random() * 2000 : 1000 + Math.random() * 1000;
      const noApiWait = needsMoreProducts ? 3000 : 2000;
      const waitForFunctionTimeout = needsMoreProducts ? 15000 : 10000; // 15s vs 10s
      const networkIdleTimeout = needsMoreProducts ? 8000 : 5000; // 8s vs 5s
      
      // Natural scrolling with mouse movement (human-like behavior)
      const viewport = await page.viewport();
      const centerX = viewport.width / 2;
      const centerY = viewport.height / 2;
      
      // Move mouse to center (human-like)
      await page.mouse.move(centerX, centerY, { steps: 10 });
      await new Promise(resolve => setTimeout(resolve, mouseMoveWait));
      
      // Scroll naturally using mouse wheel
      const scrollAmount = 500 + Math.random() * 500;
      await page.mouse.wheel({ deltaY: scrollAmount });
      await new Promise(resolve => setTimeout(resolve, mouseWheelWait));
      
      // Also scroll window to bottom
      await page.evaluate(() => {
        window.scrollTo({
          top: document.body.scrollHeight,
          behavior: 'smooth'
        });
        window.dispatchEvent(new Event('scroll', { bubbles: true }));
      });
      
      // Wait for the specific API endpoint (segapi.whop.com) with longer timeout
      try {
        const responsePromise = page.waitForResponse(
          (response) => {
            const url = response.url();
            return (url.includes('segapi.whop.com') || url.includes('api') || url.includes('graphql') || url.includes('search') || url.includes('discover')) &&
                   response.status() === 200;
          },
          { timeout: apiTimeout }
        );
        
        await responsePromise;
        log('info', 'API response received after scroll');
        
        // Wait a bit more for DOM to update (longer if we need more products)
        await new Promise(resolve => setTimeout(resolve, domUpdateWait));
      } catch (e) {
        // Timeout is okay, might not trigger API call
        log('info', 'No API response detected after scroll (timeout)');
        // Still wait a bit (longer if we need more products)
        await new Promise(resolve => setTimeout(resolve, noApiWait));
      }
      
      // Wait for DOM to actually update with new products
      // Use waitForFunction to wait for product count to increase
      try {
        await page.waitForFunction(
          (prevCount) => {
            const links = Array.from(document.querySelectorAll('a[href*="/discover/"]'));
            const productUrls = new Set();
            for (const link of links) {
              let href = link.getAttribute('href');
              if (!href || href.includes('/discover/search') || href.includes('/search?')) continue;
              if (href.startsWith('/')) href = `https://whop.com${href}`;
              if (!href.startsWith('http')) continue;
              const cleanHref = href.split('?')[0].split('#')[0];
              const match = cleanHref.match(/^https?:\/\/[^\/]+\/discover\/([^\/]+)\/([^\/]+)\/?$/);
              if (match && !cleanHref.includes('/search')) {
                productUrls.add(cleanHref.endsWith('/') ? cleanHref.slice(0, -1) : cleanHref);
              }
            }
            return productUrls.size > prevCount;
          },
          { 
            timeout: waitForFunctionTimeout,
            polling: 500 // Check every 500ms
          },
          currentProductCountInDOM
        );
        
        log('info', 'New products detected in DOM after waiting');
      } catch (e) {
        // No new products loaded, that's okay
        log('info', 'No new products detected in DOM after waiting');
      }
      
      // Wait for network to settle (longer if we need more products)
      try {
        await page.waitForNetworkIdle({ idleTime: 1000, timeout: networkIdleTimeout });
      } catch (e) {
        // Timeout is okay
      }
      
      // Extract products after waiting
      const productsAfterScroll = await extractProducts();
      productsAfterScroll.forEach(url => products.add(url));
      
      // Get mutation observer products
      const mutationDetectedProducts = await page.evaluate(() => {
        return Array.from(window.detectedProducts || []);
      });
      mutationDetectedProducts.forEach(url => {
        let normalizedUrl = url;
        if (url.startsWith('/')) {
          normalizedUrl = `https://whop.com${url}`;
        }
        normalizedUrl = normalizedUrl.split('?')[0].split('#')[0];
        if (normalizedUrl.match(/\/discover\/([^\/]+)\/([^\/]+)/)) {
          products.add(normalizedUrl);
        }
      });
      
      const currentProductCount = products.size;
      const newProducts = currentProductCount - previousProductCount;
      
      // Check if we've reached the maximum number of products requested
      if (currentProductCount >= maxProducts) {
        log('info', `Reached maximum products requested (${maxProducts}), stopping scroll`);
        break;
      }
      
      if (newProducts > 0) {
        log('info', `Found ${newProducts} new products (total: ${currentProductCount}/${maxProducts})`);
        previousProductCount = currentProductCount;
        noNewContentCount = 0;
      } else {
        noNewContentCount++;
        log('info', `No new products (total: ${currentProductCount}/${maxProducts})`);
        
        // If we haven't reached max products, be more persistent (5 attempts)
        // If we've reached max products, we can stop earlier (3 attempts)
        const maxAttemptsWithoutNewContent = currentProductCount < maxProducts ? 5 : 3;
        
        if (noNewContentCount >= maxAttemptsWithoutNewContent) {
          if (currentProductCount < maxProducts) {
            log('info', `No new products loaded after ${maxAttemptsWithoutNewContent} consecutive attempts, but only have ${currentProductCount}/${maxProducts} products. Stopping due to likely end of results.`);
          } else {
            log('info', `No new products loaded after ${maxAttemptsWithoutNewContent} consecutive attempts, stopping`);
          }
          break;
        }
      }
    }
    
    // Remove API response listener
    page.off('response', apiResponseListener);
    
    // Final wait and extraction
    log('info', 'Performing final extraction...');
    
    // Wait for any remaining network activity
    try {
      await page.waitForNetworkIdle({ idleTime: 2000, timeout: 15000 });
    } catch (e) {
      // Timeout is okay
    }
    
    // Final scroll to ensure everything is loaded
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
      window.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Final product extraction
    const finalProducts = await extractProducts();
    finalProducts.forEach(url => products.add(url));
    
    // Get final mutation observer products
    const finalMutationProducts = await page.evaluate(() => {
      return Array.from(window.detectedProducts || []);
    });
    finalMutationProducts.forEach(url => {
      let normalizedUrl = url;
      if (url.startsWith('/')) {
        normalizedUrl = `https://whop.com${url}`;
      }
      normalizedUrl = normalizedUrl.split('?')[0].split('#')[0];
      if (normalizedUrl.match(/\/discover\/([^\/]+)\/([^\/]+)/)) {
        products.add(normalizedUrl);
      }
    });
    
    const totalAfterScroll = products.size;
    const newProducts = totalAfterScroll - initialProductCount;
    
    if (newProducts > 0) {
      log('info', `After waiting for responses: Found ${newProducts} additional products (total: ${totalAfterScroll})`);
    } else {
      log('info', `After waiting for responses: Total products remains ${totalAfterScroll}`);
    }
    
    // Clean up MutationObserver
    await page.evaluate(() => {
      if (window.mutationObserver) {
        window.mutationObserver.disconnect();
        window.mutationObserverActive = false;
      }
    });
  }
  
  const productArray = Array.from(products).slice(0, maxProducts);
  log('success', `Found ${productArray.length} products to scrape`);
  
  if (productArray.length === 0) {
    log('warning', 'No products found. This could indicate:');
    log('warning', '1. The page structure has changed');
    log('warning', '2. Bot detection is blocking the scraper');
    log('warning', '3. The search query returned no results');
    log('warning', 'Try running with headless: false to see what\'s happening');
  }
  
  return productArray;
}

// Extract social links and creator info from a product page
async function scrapeProductPage(page, productUrl) {
  try {
    await page.goto(productUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    
    const data = await page.evaluate((whopHandles) => {
      const result = {
        productName: '',
        creatorName: '',
        creatorHandle: '',
        twitter: '',
        instagram: '',
        youtube: '',
        tiktok: '',
        discord: '',
        linkedin: '',
        telegram: '',
      };
      
      // Get product name from title or h1
      const title = document.querySelector('h1')?.textContent?.trim() || 
                    document.title.replace(' | Whop', '').trim();
      result.productName = title;
      
      // Extract JSON-LD data for creator info
      const jsonLdScripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const script of jsonLdScripts) {
        try {
          const data = JSON.parse(script.textContent);
          if (data['@type'] === 'Product' && data.brand?.name) {
            result.creatorName = data.brand.name;
          }
        } catch (e) {}
      }
      
      // Extract Whop handle from profile link
      const profileLinks = document.querySelectorAll('a[href*="whop.com/@"]');
      for (const link of profileLinks) {
        const href = link.getAttribute('href');
        const match = href?.match(/whop\.com\/@([a-zA-Z0-9_]+)/);
        if (match) {
          const handle = match[1].toLowerCase();
          if (!whopHandles.includes(handle)) {
            result.creatorHandle = `@${match[1]}`;
            break;
          }
        }
      }
      
      // Helper to check if URL is Whop's own social
      const isWhopSocial = (url) => {
        const lower = url.toLowerCase();
        return whopHandles.some(h => lower.includes(`/${h}`) || lower.includes(`@${h}`));
      };
      
      // Extract social links
      const allLinks = document.querySelectorAll('a[href]');
      for (const link of allLinks) {
        const href = link.getAttribute('href') || '';
        const lowerHref = href.toLowerCase();
        
        if (isWhopSocial(href)) continue;
        
        if ((lowerHref.includes('twitter.com/') || lowerHref.includes('x.com/')) && !result.twitter) {
          result.twitter = href;
        } else if (lowerHref.includes('instagram.com/') && !result.instagram) {
          result.instagram = href;
        } else if (lowerHref.includes('youtube.com/') && !result.youtube) {
          result.youtube = href;
        } else if (lowerHref.includes('tiktok.com/') && !result.tiktok) {
          result.tiktok = href;
        } else if (lowerHref.includes('discord.gg/') || lowerHref.includes('discord.com/')) {
          if (!result.discord) result.discord = href;
        } else if (lowerHref.includes('linkedin.com/') && !result.linkedin) {
          result.linkedin = href;
        } else if (lowerHref.includes('t.me/') && !result.telegram) {
          result.telegram = href;
        }
      }
      
      return result;
    }, WHOP_HANDLES);
    
    // If no socials found, try the creator's profile page
    if (!data.twitter && !data.instagram && data.creatorHandle) {
      const profileUrl = `https://whop.com/${data.creatorHandle.replace('@', '@')}`;
      try {
        await page.goto(profileUrl, { waitUntil: 'networkidle2', timeout: 20000 });
        
        const profileData = await page.evaluate((whopHandles) => {
          const socials = {
            twitter: '',
            instagram: '',
            youtube: '',
            tiktok: '',
            discord: '',
            linkedin: '',
            telegram: '',
          };
          
          const isWhopSocial = (url) => {
            const lower = url.toLowerCase();
            return whopHandles.some(h => lower.includes(`/${h}`) || lower.includes(`@${h}`));
          };
          
          const allLinks = document.querySelectorAll('a[href]');
          for (const link of allLinks) {
            const href = link.getAttribute('href') || '';
            const lowerHref = href.toLowerCase();
            
            if (isWhopSocial(href)) continue;
            
            if ((lowerHref.includes('twitter.com/') || lowerHref.includes('x.com/')) && !socials.twitter) {
              socials.twitter = href;
            } else if (lowerHref.includes('instagram.com/') && !socials.instagram) {
              socials.instagram = href;
            } else if (lowerHref.includes('youtube.com/') && !socials.youtube) {
              socials.youtube = href;
            } else if (lowerHref.includes('tiktok.com/') && !socials.tiktok) {
              socials.tiktok = href;
            } else if ((lowerHref.includes('discord.gg/') || lowerHref.includes('discord.com/')) && !socials.discord) {
              socials.discord = href;
            } else if (lowerHref.includes('linkedin.com/') && !socials.linkedin) {
              socials.linkedin = href;
            } else if (lowerHref.includes('t.me/') && !socials.telegram) {
              socials.telegram = href;
            }
          }
          
          return socials;
        }, WHOP_HANDLES);
        
        // Merge profile socials into data
        Object.keys(profileData).forEach(key => {
          if (profileData[key] && !data[key]) {
            data[key] = profileData[key];
          }
        });
      } catch (e) {
        // Profile page failed, continue with what we have
      }
    }
    
    return {
      productUrl,
      ...data,
    };
  } catch (error) {
    log('error', `Failed to scrape ${productUrl}: ${error.message}`);
    return {
      productUrl,
      productName: '',
      creatorName: '',
      creatorHandle: '',
      twitter: '',
      instagram: '',
      youtube: '',
      tiktok: '',
      discord: '',
      linkedin: '',
      telegram: '',
    };
  }
}

// Export results to CSV
function exportToCSV(results) {
  const headers = [
    'Product Name',
    'Product URL',
    'Creator Name',
    'Creator Handle',
    'Twitter/X',
    'Instagram',
    'YouTube',
    'TikTok',
    'Discord',
    'LinkedIn',
    'Telegram',
  ];
  
  const escapeCSV = (str) => {
    if (!str) return '';
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };
  
  const rows = results.map(r => [
    escapeCSV(r.productName),
    escapeCSV(r.productUrl),
    escapeCSV(r.creatorName),
    escapeCSV(r.creatorHandle),
    escapeCSV(r.twitter),
    escapeCSV(r.instagram),
    escapeCSV(r.youtube),
    escapeCSV(r.tiktok),
    escapeCSV(r.discord),
    escapeCSV(r.linkedin),
    escapeCSV(r.telegram),
  ].join(','));
  
  return [headers.join(','), ...rows].join('\n');
}

// Main scraping function (exported for API use)
async function runScraper(config = {}, onProgress = null) {
  const CONFIG = { ...DEFAULT_CONFIG, ...config };
  log('info', 'Launching browser...');
  
  const browser = await puppeteer.launch({
    headless: CONFIG.headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--window-size=1920,1080',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
  });
  
  try {
    const page = await browser.newPage();
    
    // Enhanced anti-detection - must be set before navigation
    await page.evaluateOnNewDocument(() => {
      // Remove webdriver property completely
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
      });
      
      // Override plugins to look real
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5],
      });
      
      // Override languages
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en'],
      });
      
      // Add Chrome property with more details
      window.chrome = {
        runtime: {},
        loadTimes: function() {},
        csi: function() {},
        app: {}
      };
      
      // Override permissions
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications' ?
          Promise.resolve({ state: Notification.permission }) :
          originalQuery(parameters)
      );
      
      // Mock platform
      Object.defineProperty(navigator, 'platform', {
        get: () => 'MacIntel',
      });
      
      // Override getBattery if it exists
      if (navigator.getBattery) {
        navigator.getBattery = () => Promise.resolve({
          charging: true,
          chargingTime: 0,
          dischargingTime: Infinity,
          level: 1,
        });
      }
    });
    
    // Set viewport and user agent
    await page.setViewport({ width: 1920, height: 1080 });
    
    // Enhanced user agent
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    );
    
    // Set extra headers with more realistic values
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Cache-Control': 'max-age=0',
    });
    
    // Get product URLs from search
    const productUrls = await scrapeSearchResults(page, CONFIG.searchQuery, CONFIG.maxProducts, CONFIG.scrollDelay, CONFIG.maxScrollAttempts, CONFIG);
    
    if (productUrls.length === 0) {
      log('error', 'No products found');
      return {
        results: [],
        stats: {
          total: 0,
          withTwitter: 0,
          withInstagram: 0,
          withYouTube: 0,
          withTikTok: 0,
          withDiscord: 0,
          withLinkedIn: 0,
          withTelegram: 0,
        },
        csv: exportToCSV([]),
        filename: null,
      };
    }
    
    // Scrape each product page
    const results = [];
    for (let i = 0; i < productUrls.length; i++) {
      const url = productUrls[i];
      log('info', `Scraping product ${i + 1}/${productUrls.length}: ${url}`);
      
      const productData = await scrapeProductPage(page, url);
      results.push(productData);
      
      // Calculate current stats
      const currentStats = {
        total: results.length,
        withTwitter: results.filter(r => r.twitter).length,
        withInstagram: results.filter(r => r.instagram).length,
        withYouTube: results.filter(r => r.youtube).length,
        withTikTok: results.filter(r => r.tiktok).length,
        withDiscord: results.filter(r => r.discord).length,
        withLinkedIn: results.filter(r => r.linkedin).length,
        withTelegram: results.filter(r => r.telegram).length,
      };
      
      // Call progress callback if provided
      if (onProgress) {
        onProgress({
          product: productData,
          progress: {
            current: i + 1,
            total: productUrls.length,
          },
          stats: currentStats,
        });
      }
      
      // Log social links found
      const socials = [
        productData.twitter && 'Twitter',
        productData.instagram && 'Instagram',
        productData.youtube && 'YouTube',
        productData.tiktok && 'TikTok',
        productData.discord && 'Discord',
        productData.linkedin && 'LinkedIn',
        productData.telegram && 'Telegram',
      ].filter(Boolean);
      
      if (socials.length > 0) {
        log('success', `  Found: ${productData.creatorName || 'Unknown'} - ${socials.join(', ')}`);
      } else {
        log('warning', `  No social links found for ${productData.productName || url}`);
      }
      
      // Small delay between requests
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Export to CSV
    const csv = exportToCSV(results);
    const filename = `whop-scrape-${CONFIG.searchQuery}-${Date.now()}.csv`;
    fs.writeFileSync(filename, csv);
    
    log('success', `Scraping complete! Results saved to ${filename}`);
    
    // Print summary
    const stats = {
      total: results.length,
      withTwitter: results.filter(r => r.twitter).length,
      withInstagram: results.filter(r => r.instagram).length,
      withYouTube: results.filter(r => r.youtube).length,
      withTikTok: results.filter(r => r.tiktok).length,
      withDiscord: results.filter(r => r.discord).length,
      withLinkedIn: results.filter(r => r.linkedin).length,
      withTelegram: results.filter(r => r.telegram).length,
    };
    
    console.log('\n--- Summary ---');
    console.log(`Total products scraped: ${stats.total}`);
    console.log(`With Twitter/X: ${stats.withTwitter}`);
    console.log(`With Instagram: ${stats.withInstagram}`);
    console.log(`With YouTube: ${stats.withYouTube}`);
    console.log(`With TikTok: ${stats.withTikTok}`);
    console.log(`With Discord: ${stats.withDiscord}`);
    console.log(`With LinkedIn: ${stats.withLinkedIn}`);
    console.log(`With Telegram: ${stats.withTelegram}`);
    
    return {
      results,
      stats,
      csv,
      filename,
    };
  } finally {
    await browser.close();
  }
}

// Export the function for use in API
module.exports = { runScraper, exportToCSV };

// Run the scraper if called directly (CLI mode)
if (require.main === module) {
  runScraper().catch(error => {
    log('error', `Fatal error: ${error.message}`);
    process.exit(1);
  });
}

