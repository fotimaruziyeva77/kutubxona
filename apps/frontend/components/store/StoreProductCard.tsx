"use client";

import { Card, CardContent } from "@/components/ui/card";

interface StoreProductCardProps {
  isbn: string;
  title: string;
  author: string;
  price: number;
  stockCount: number;
  coverUrl?: string;
  premiumBadge?: boolean;
}

function formatPrice(price: number): string {
  return new Intl.NumberFormat("uz-UZ").format(price) + " so'm";
}

export default function StoreProductCard({
  isbn,
  title,
  author,
  price,
  stockCount,
  coverUrl,
  premiumBadge,
}: StoreProductCardProps) {
  return (
    <Card className="overflow-hidden hover:shadow-md transition-shadow">
      {/* Cover image or fallback */}
      <div className="aspect-[3/4] bg-surface-sunken flex items-center justify-center relative">
        {coverUrl ? (
          <img
            src={coverUrl}
            alt={title}
            className="w-full h-full object-cover"
          />
        ) : (
          <svg
            className="w-12 h-12 text-slate-300"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25"
            />
          </svg>
        )}

        {/* Premium badge */}
        {premiumBadge && (
          <span className="absolute top-2 right-2 bg-amber-400 text-amber-900 text-xs font-bold px-2 py-0.5 rounded-full flex items-center gap-1">
            <svg
              className="w-3 h-3"
              fill="currentColor"
              viewBox="0 0 20 20"
            >
              <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
            </svg>
            Premium
          </span>
        )}

        {/* Stock badge */}
        <span
          className={`absolute bottom-2 left-2 text-xs font-semibold px-2 py-0.5 rounded-full ${
            stockCount > 0
              ? "bg-green-100 text-green-800"
              : "bg-red-100 text-red-800"
          }`}
        >
          {stockCount > 0 ? "Mavjud" : "Tugagan"}
        </span>
      </div>

      <CardContent className="p-4">
        <h3 className="font-semibold text-sm text-slate-900 line-clamp-2 mb-1">
          {title}
        </h3>
        <p className="text-xs text-slate-500 mb-2 truncate">{author}</p>
        <div className="flex items-center justify-between">
          <span className="text-sm font-bold text-brand-700">
            {formatPrice(price)}
          </span>
          <span className="text-xs text-slate-400">ISBN: {isbn.slice(-4)}</span>
        </div>
      </CardContent>
    </Card>
  );
}
