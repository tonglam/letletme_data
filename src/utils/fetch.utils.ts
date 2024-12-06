import fetch from 'node-fetch';
import querystring from 'querystring';

const fetchData = async (url: string, options = {}) => {
  try {
    const response = await fetch(url, {
      ...options,
      timeout: 5000,
    });
    if (!response.ok) {
      console.error(`HTTP error! Status: ${response.status}`);
    }
    const contentType = response.headers.get('Content-Type');
    if (contentType && contentType.includes('application/json')) {
      return await response.json();
    } else {
      return await response.text();
    }
  } catch (error) {
    console.error('Error:', error);
  } finally {
    if (global.gc) global.gc();
  }
};

const getFetch =
  (url: string) =>
  (data = {}) =>
  async (headers = {}) => {
    const queryParams = querystring.stringify(data);
    const apiUrl = queryParams ? `${url}?${queryParams}` : url;
    return await fetchData(apiUrl, { headers });
  };

const postFetch =
  (url: string) =>
  (data = {}) =>
  async (headers = {}) => {
    let options = {};

    if (data instanceof FormData) {
      options = {
        method: 'POST',
        body: data,
        headers: headers,
      };
    } else {
      options = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        body: JSON.stringify(data),
      };
    }

    return await fetchData(url, options);
  };

export { getFetch, postFetch };
