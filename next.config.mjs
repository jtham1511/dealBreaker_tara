/** @type {import('next').NextConfig} */
const nextConfig = {
  async redirects() { return [{ source: '/', destination: '/INDEX.html', permanent: false }]; },
};
export default nextConfig;
