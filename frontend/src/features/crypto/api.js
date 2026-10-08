import api from '../../utils/api';

export async function fetchCryptoMeta() {
  const response = await api.get('/api/crypto/meta');
  return response.data;
}
