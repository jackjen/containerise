import Storage from './Storage/HostStorage';
import ContextualIdentity, {NO_CONTAINER} from './ContextualIdentity';
import Tabs from './Tabs';
import PreferenceStorage from './Storage/PreferenceStorage';
import {filterByKey} from './utils';
import {buildDefaultContainer} from './defaultContainer';

const IGNORED_URLS_REGEX = /^(about|moz-extension):/;

/**
 * Keep track of the tabs we're creating
 * tabId: url
 */
const creatingTabs = {};

const createTab = (url, newTabIndex, currentTabId, openerTabId, cookieStoreId) => {
  Tabs.get(currentTabId).then((currentTab) => {
    const createOptions = {
      url,
      index: newTabIndex,
      cookieStoreId,
      active: currentTab.active,
    };
    // Passing the openerTabId without a cookieStoreId
    // creates a tab in the same container as the opener
    if (cookieStoreId && openerTabId) {
      createOptions.openerTabId = openerTabId;
    }
    Tabs.create(createOptions).then((createdTab) => {
      creatingTabs[createdTab.id] = url;
      if (!cookieStoreId && openerTabId) {
        Tabs.update(createdTab.id, {
          openerTabId: openerTabId,
        });
      }
    });
    PreferenceStorage.get('keepOldTabs').then(({value}) => {
      if (!value) {
        Tabs.remove(currentTabId);
      }
    }).catch(() => {
      Tabs.remove(currentTabId);
    });

  });

  return {
    cancel: true,
  };
};


async function handle(url, tabId) {
  const creatingUrl = creatingTabs[tabId];
  if (IGNORED_URLS_REGEX.test(url) || creatingUrl === url) {
    return;
  } else if (creatingUrl) {
    delete creatingTabs[tabId];
  }

  let [hostMap, preferences, identities, currentTab] = await Promise.all([
    Storage.get(url),
    PreferenceStorage.getAll(true),
    ContextualIdentity.getAll(),
    Tabs.get(tabId),
  ]);

  if (currentTab.incognito || !hostMap) {
    return {};
  }

  const hostIdentity = identities.find((identity) => identity.cookieStoreId === hostMap.cookieStoreId);
  const tabIdentity = identities.find((identity) => identity.cookieStoreId === currentTab.cookieStoreId);

  if (!hostIdentity) {
    if (preferences.defaultContainer) {
      const defaultContainer = await buildDefaultContainer(
          filterByKey(preferences, prefKey => prefKey.startsWith('defaultContainer')),
          url
      );
      const defaultCookieStoreId = defaultContainer.cookieStoreId;
      const defaultIsNoContainer = defaultCookieStoreId === NO_CONTAINER.cookieStoreId;
      const tabHasContainer = currentTab.cookieStoreId !== NO_CONTAINER.cookieStoreId;
      const tabInDifferentContainer = currentTab.cookieStoreId !== defaultCookieStoreId;
      const openInNoContainer = defaultIsNoContainer && tabHasContainer;
      if ((tabInDifferentContainer && !openInNoContainer) || openInNoContainer) {
        console.debug('Opening', url, 'in default container', defaultCookieStoreId, defaultContainer.name);
        return createTab(
            url,
            currentTab.index + 1, currentTab.id,
            currentTab.openerTabId,
            defaultCookieStoreId);
      }
    }
    return {};

  }

  const openerTabId = currentTab.openerTabId;
  if (hostIdentity.cookieStoreId === NO_CONTAINER.cookieStoreId && tabIdentity) {
    return createTab(url, currentTab.index + 1, currentTab.id, openerTabId);
  }

  if (hostIdentity.cookieStoreId !== currentTab.cookieStoreId && hostIdentity.cookieStoreId !== NO_CONTAINER.cookieStoreId) {
    return createTab(url, currentTab.index + 1, currentTab.id, openerTabId, hostIdentity.cookieStoreId);
  }


  return {};

}

export const webRequestListener = (requestDetails) => {

  if (requestDetails.frameId !== 0 || requestDetails.tabId === -1) {
    return {};
  }
  return handle(requestDetails.url, requestDetails.tabId);
};

export const tabUpdatedListener = (tabId, changeInfo) => {
  if (!changeInfo.url) {
    return;
  }
  return handle(changeInfo.url, tabId);
};