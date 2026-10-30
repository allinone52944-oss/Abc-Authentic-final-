// ============================================================
// Land mouza-value LOOKUP data — PROOF + BATCH 1.
// Boalkhali (proof) + 5 Chattogram offices (batch 1), all
// 2025-2026. Rates are per SHATANGSHO, transcribed from the
// office schedule scans. No portal is called and no endpoint
// is guessed: this file is the schedule data itself, entered
// once and read back.
//
// Mapping rule (strict): the engine's class list is নাল, বাড়ী,
// ভিটা, বাগান, পুকুর, ডোবা, বাণিজ্যিক. ONLY exact-name matches
// are lookup classes. Columns that do not match an engine class
// (খাল, দোকান, পতিত, বিলা, বাঁশঝাড়, পথ, টিলা/পাহাড়,
// ফলবাগান, গার্ডেন, বিবিধ) are stored under `otherColumns`
// for reference ONLY — lookupMouzaRate never returns them, and
// দোকান is NEVER mapped to বাণিজ্যিক. বাণিজ্যিক therefore has
// no lookup rate anywhere. A class with no rate in the source
// (X / — / blank / n/a, or a column the office table lacks)
// is ABSENT from `rates` — never 0 — so lookup returns
// found:false for it while sibling classes still work.
//
// P flag: the schedule footnote marks P rows as "no sale deed
// registered, so the previous value remains in force". The P
// number IS the applicable rate; `p: true` only carries the
// note so the UI can show it.
//
// Batch-1 specifics (all machine-transcribed from
// rates-chattogram-batch1.md, 0-mismatch verified):
// - THANA QUALIFIER (Chandgaon only): one file holds 3 thanas
//   and বাকলিয়া / চান্দগাঁও / চর মোহরা appear in several with
//   different rates, so those names carry `variants` (one per
//   thana) instead of a single entry. A lookup without thana
//   that matches several variants is AMBIGUOUS (see below),
//   never merged. Unambiguous names are plain entries.
// - `jl` is stored where the schedule gives one (Chandgaon,
//   Pahartali); elsewhere it is absent, never invented.
// - SANDWIP POURO: the পুকুর rate is the gram value; where the
//   schedule also prints a pouro value it is kept as
//   `pouroPukur` and surfaced as a note, never substituted.
// - Gachbaria "বাড়ীভিটি" is a joint reference class and is
//   NOT entered as বাড়ী or ভিটা. Rangunia has no বাড়ী column
//   (ভিটা is never passed off as বাড়ী). Pahartali plot rows
//   are not mouzas and are NOT entered.
// ============================================================

// ---- Batch 2 (Chattogram district remaining, 2025-2026): machine-transcribed
// from rates-chattogram-batch2.md (862 mouza rows, 4254 class-rates, verified
// 0-mismatch against reader JSON). 11 office entries cover the district's 15
// remaining checklist entries: mirsharai-jorarganj, fatikchhari and
// hathazari-fateyabad are COMBINED schedules (one document, no per-row office
// split printed), so each covers several checklist entries.
// - COLLISION RULE (extends the Chandgaon thana rule): thana-distinguished
//   names -> variants[]; a printed qualifier under the name (Sadar Shikalbaha
//   "borof" notes) -> name suffix, plain entries (Sandwip (chor)/(bak)
//   precedent); JL-only collisions (Patiya, Raozan) -> "(JL <printed>)" suffix;
//   kromik-only collision (Sitakunda Latifpur, no JL/thana) -> "(krom <n>)" suffix.
// - Sadar period caveat: no Sadar page prints an end date, only "effective from
//   1 Jan 2025"; included as 2025-2026 because its Nov 2024 approval and the
//   01/01/2023-31/10/2024 deed basis match the other schedules' cycle exactly.
// - Sadar geo upazila is Kotowali (office location); the office covers 5 thanas.
// - "Vita/bastu vita" (Adhunagar, Satkania) maps to vita ONLY (Rangunia
//   precedent: vita is never passed off as bari). Text cells (e.g. Satkania
//   "chhonkhola 2277" in doba) stay no-rate, never converted.
// - Zero-engine-rate rows (6) stay as entries with rates:{} (in the table, but
//   no lookup rate) rather than being dropped or reported as not-in-table.
const OFFICES = {
  boalkhali: {
    // Display name only — no source site name, link or branding
    // is stored here or shown to customers.
    name: 'বোয়ালখালী',
    period: '2025-2026',
    mouzas: {
      'কধুরখীল': {
        // Lookup classes: exact-name matches only, per shatangsho.
        rates: {
          'নাল': { rate: 121421 },
          'বাড়ী': { rate: 157248 },
          'ভিটা': { rate: 140752 },
          'বাগান': { rate: 147838 },
          'পুকুর': { rate: 109707 },
          'ডোবা': { rate: 100000, p: true },
        },
        // NOT lookup classes — reference only, never returned.
        otherColumns: {
          'খাল': 162756,
          'দোকান': { rate: 1400000, p: true },
          'পতিত': { rate: 50000, p: true },
          'বিলা': 212528,
          'বাঁশঝাড়': 500000,
          'পথ': 256000,
          'টিলা/পাহাড়': null,
          'ফলবাগান': null,
          'গার্ডেন': null,
        },
        // Informational only — never a lookup class.
        notes: 'বিবিধ: কবরস্থান 478571 (তথ্য মাত্র)',
      },
    },
  },
  // ---- Batch 1 (Chattogram, 2025-2026): machine-transcribed
  // from rates-chattogram-batch1.md (174 mouza rows, verified
  // 0-mismatch by /tmp/batch1-verify.js). See the header note.
  chandgaon: {
    "name": "চাঁদগাঁও থানা",
    "period": "2025-2026",
    "mouzas": {
      "চান্দগাঁও": {
        "variants": [
          {
            "rates": {
              "নাল": {
                "rate": 737140
              },
              "বাড়ী": {
                "rate": 1531463
              },
              "ভিটা": {
                "rate": 1531463
              },
              "পুকুর": {
                "rate": 961494
              },
              "ডোবা": {
                "rate": 961494
              }
            },
            "jl": "9",
            "thana": "চান্দগাঁও"
          },
          {
            "rates": {
              "নাল": {
                "rate": 450000,
                "p": true
              },
              "বাড়ী": {
                "rate": 650000,
                "p": true
              },
              "ভিটা": {
                "rate": 650000,
                "p": true
              },
              "পুকুর": {
                "rate": 115175,
                "p": true
              }
            },
            "jl": "9",
            "thana": "বদর"
          }
        ]
      },
      "মোহরা": {
        "rates": {
          "নাল": {
            "rate": 687088
          },
          "বাড়ী": {
            "rate": 1107675
          },
          "ভিটা": {
            "rate": 1107675
          },
          "পুকুর": {
            "rate": 646815
          },
          "ডোবা": {
            "rate": 646815
          }
        },
        "jl": "11"
      },
      "চর মোহরা": {
        "variants": [
          {
            "rates": {
              "বাড়ী": {
                "rate": 800000,
                "p": true
              },
              "ভিটা": {
                "rate": 800000,
                "p": true
              }
            },
            "jl": "11",
            "thana": "চান্দগাঁও"
          },
          {
            "rates": {
              "বাড়ী": {
                "rate": 93000,
                "p": true
              },
              "ভিটা": {
                "rate": 93000,
                "p": true
              }
            },
            "jl": "11",
            "thana": "বদর"
          }
        ]
      },
      "চর রাঙ্গামাটিয়া": {
        "rates": {
          "নাল": {
            "rate": 638123
          },
          "বাড়ী": {
            "rate": 1163888
          },
          "ভিটা": {
            "rate": 1163888
          },
          "পুকুর": {
            "rate": 1106015
          },
          "ডোবা": {
            "rate": 1106015
          }
        },
        "jl": "13"
      },
      "পূর্ব ষোলশহর": {
        "rates": {
          "নাল": {
            "rate": 1250237
          },
          "বাড়ী": {
            "rate": 1532522
          },
          "ভিটা": {
            "rate": 1532522
          },
          "পুকুর": {
            "rate": 969440
          },
          "ডোবা": {
            "rate": 969440
          }
        },
        "jl": "14"
      },
      "বাকলিয়া": {
        "variants": [
          {
            "rates": {
              "নাল": {
                "rate": 878242
              },
              "বাড়ী": {
                "rate": 1552176
              },
              "ভিটা": {
                "rate": 1552176
              },
              "পুকুর": {
                "rate": 939613
              },
              "ডোবা": {
                "rate": 939613
              }
            },
            "jl": "15",
            "thana": "চান্দগাঁও"
          },
          {
            "rates": {
              "নাল": {
                "rate": 693896
              },
              "বাড়ী": {
                "rate": 1568154
              },
              "ভিটা": {
                "rate": 1568154
              },
              "পুকুর": {
                "rate": 608105
              }
            },
            "jl": "8",
            "thana": "বদর"
          },
          {
            "rates": {
              "নাল": {
                "rate": 950000,
                "p": true
              },
              "বাড়ী": {
                "rate": 2129214,
                "p": true
              },
              "ভিটা": {
                "rate": 2129214,
                "p": true
              },
              "পুকুর": {
                "rate": 937500,
                "p": true
              }
            },
            "jl": "13",
            "thana": "পাঁচলাইশ"
          }
        ]
      },
      "চর বাকলিয়া": {
        "rates": {
          "নাল": {
            "rate": 101927
          }
        },
        "jl": "15"
      }
    }
  },
  sandwip: {
    "name": "সন্দ্বীপ",
    "period": "2025-2026",
    "mouzas": {
      "আজিমপুর": {
        "rates": {
          "নাল": {
            "rate": 5529
          },
          "বাড়ী": {
            "rate": 10595
          },
          "ভিটা": {
            "rate": 10595
          },
          "বাগান": {
            "rate": 11044
          },
          "পুকুর": {
            "rate": 7501
          },
          "ডোবা": {
            "rate": 6000
          }
        }
      },
      "আমান উল্যা": {
        "rates": {
          "নাল": {
            "rate": 8552
          },
          "বাড়ী": {
            "rate": 17531
          },
          "ভিটা": {
            "rate": 17531
          },
          "বাগান": {
            "rate": 26416,
            "p": true
          },
          "পুকুর": {
            "rate": 38118
          },
          "ডোবা": {
            "rate": 12443
          }
        }
      },
      "কাটগড়": {
        "rates": {
          "নাল": {
            "rate": 6913
          },
          "বাড়ী": {
            "rate": 2125
          },
          "ভিটা": {
            "rate": 2125
          },
          "বাগান": {
            "rate": 921,
            "p": true
          },
          "পুকুর": {
            "rate": 3894
          }
        }
      },
      "কাহিয়াপাড়": {
        "rates": {
          "নাল": {
            "rate": 25628
          },
          "বাড়ী": {
            "rate": 41150
          },
          "ভিটা": {
            "rate": 41150
          },
          "বাগান": {
            "rate": 17140
          },
          "পুকুর": {
            "rate": 39902
          },
          "ডোবা": {
            "rate": 46512
          }
        },
        "pouroPukur": 59266
      },
      "কাহিয়াপাড় (চর)": {
        "rates": {
          "নাল": {
            "rate": 12225
          },
          "বাড়ী": {
            "rate": 37200
          },
          "ভিটা": {
            "rate": 37200
          },
          "বাগান": {
            "rate": 19231
          },
          "পুকুর": {
            "rate": 36951
          },
          "ডোবা": {
            "rate": 13072
          }
        }
      },
      "কাহিয়াপাড় (বাক)": {
        "rates": {
          "নাল": {
            "rate": 5850
          },
          "বাড়ী": {
            "rate": 2412,
            "p": true
          },
          "ভিটা": {
            "rate": 2412,
            "p": true
          },
          "বাগান": {
            "rate": 2010,
            "p": true
          },
          "পুকুর": {
            "rate": 4000,
            "p": true
          }
        }
      },
      "কালাপানিয়া": {
        "rates": {
          "নাল": {
            "rate": 21476
          },
          "বাড়ী": {
            "rate": 3918
          },
          "ভিটা": {
            "rate": 3918
          },
          "বাগান": {
            "rate": 17854
          },
          "পুকুর": {
            "rate": 30928
          },
          "ডোবা": {
            "rate": 22924
          }
        }
      },
      "কুহিয়ামোড়া": {
        "rates": {
          "নাল": {
            "rate": 37068
          },
          "বাড়ী": {
            "rate": 28868
          },
          "ভিটা": {
            "rate": 28868
          },
          "বাগান": {
            "rate": 37907
          },
          "পুকুর": {
            "rate": 46378
          },
          "ডোবা": {
            "rate": 59960
          }
        },
        "pouroPukur": 37614
      },
      "কুহিয়ামোড়া (চর)": {
        "rates": {
          "নাল": {
            "rate": 12859
          },
          "বাড়ী": {
            "rate": 20000
          },
          "ভিটা": {
            "rate": 20000
          },
          "বাগান": {
            "rate": 3626,
            "p": true
          },
          "পুকুর": {
            "rate": 20000
          }
        }
      },
      "কুহিয়ামোড়া (বাক)": {
        "rates": {
          "নাল": {
            "rate": 8071
          },
          "বাড়ী": {
            "rate": 5806
          },
          "ভিটা": {
            "rate": 5806
          },
          "বাগান": {
            "rate": 1818,
            "p": true
          },
          "পুকুর": {
            "rate": 26451
          },
          "ডোবা": {
            "rate": 8930,
            "p": true
          }
        }
      },
      "গাছুয়া": {
        "rates": {
          "নাল": {
            "rate": 30920
          },
          "বাড়ী": {
            "rate": 54974
          },
          "ভিটা": {
            "rate": 54974
          },
          "বাগান": {
            "rate": 75276
          },
          "পুকুর": {
            "rate": 39906
          },
          "ডোবা": {
            "rate": 31174
          }
        }
      },
      "গাছুয়া (চর)": {
        "rates": {
          "নাল": {
            "rate": 14648
          },
          "বাড়ী": {
            "rate": 28412
          },
          "ভিটা": {
            "rate": 28412
          },
          "বাগান": {
            "rate": 2000,
            "p": true
          },
          "পুকুর": {
            "rate": 27395,
            "p": true
          }
        }
      },
      "গাছুয়া (বাক)": {
        "rates": {
          "নাল": {
            "rate": 14412
          },
          "বাড়ী": {
            "rate": 5562,
            "p": true
          },
          "ভিটা": {
            "rate": 5562,
            "p": true
          },
          "বাগান": {
            "rate": 4566,
            "p": true
          },
          "পুকুর": {
            "rate": 36250
          }
        }
      },
      "চেউরিয়া": {
        "rates": {
          "নাল": {
            "rate": 36323
          },
          "বাড়ী": {
            "rate": 39927
          },
          "ভিটা": {
            "rate": 39927
          },
          "বাগান": {
            "rate": 4566,
            "p": true
          },
          "পুকুর": {
            "rate": 52541
          },
          "ডোবা": {
            "rate": 6694,
            "p": true
          }
        }
      },
      "চৌকাতলী": {
        "rates": {
          "নাল": {
            "rate": 4304
          },
          "বাড়ী": {
            "rate": 25822
          },
          "ভিটা": {
            "rate": 25822
          },
          "বাগান": {
            "rate": 57859
          },
          "পুকুর": {
            "rate": 32208
          },
          "ডোবা": {
            "rate": 28302
          }
        }
      },
      "দীর্ঘাপাড়": {
        "rates": {
          "নাল": {
            "rate": 17112
          },
          "বাড়ী": {
            "rate": 33392
          },
          "ভিটা": {
            "rate": 33392
          },
          "বাগান": {
            "rate": 7759
          },
          "পুকুর": {
            "rate": 14262
          },
          "ডোবা": {
            "rate": 19643
          }
        }
      },
      "দীর্ঘাপাড় (চর)": {
        "rates": {
          "নাল": {
            "rate": 3863
          },
          "বাড়ী": {
            "rate": 16720
          },
          "ভিটা": {
            "rate": 16720
          },
          "বাগান": {
            "rate": 4000
          },
          "পুকুর": {
            "rate": 7500
          }
        }
      },
      "দীর্ঘাপাড় (বাক)": {
        "rates": {
          "নাল": {
            "rate": 3396
          },
          "বাড়ী": {
            "rate": 750,
            "p": true
          },
          "ভিটা": {
            "rate": 750,
            "p": true
          },
          "বাগান": {
            "rate": 612,
            "p": true
          },
          "পুকুর": {
            "rate": 775,
            "p": true
          }
        }
      },
      "দুর্বলাপাড়": {
        "rates": {
          "নাল": {
            "rate": 6111,
            "p": true
          },
          "বাড়ী": {
            "rate": 8584,
            "p": true
          },
          "ভিটা": {
            "rate": 8584,
            "p": true
          },
          "বাগান": {
            "rate": 500,
            "p": true
          },
          "পুকুর": {
            "rate": 7906,
            "p": true
          }
        }
      },
      "বাউরিয়া": {
        "rates": {
          "নাল": {
            "rate": 30658
          },
          "বাড়ী": {
            "rate": 52851
          },
          "ভিটা": {
            "rate": 52851
          },
          "বাগান": {
            "rate": 38599
          },
          "পুকুর": {
            "rate": 46817
          },
          "ডোবা": {
            "rate": 59689
          }
        },
        "pouroPukur": 31291
      },
      "বাউরিয়া (চর)": {
        "rates": {
          "নাল": {
            "rate": 17376
          },
          "বাড়ী": {
            "rate": 22614
          },
          "ভিটা": {
            "rate": 22614
          },
          "বাগান": {
            "rate": 4726,
            "p": true
          },
          "পুকুর": {
            "rate": 10102,
            "p": true
          }
        }
      },
      "বাউরিয়া (বাক)": {
        "rates": {
          "নাল": {
            "rate": 17090
          },
          "বাড়ী": {
            "rate": 16667
          },
          "ভিটা": {
            "rate": 16667
          },
          "বাগান": {
            "rate": 2735,
            "p": true
          },
          "পুকুর": {
            "rate": 3955,
            "p": true
          },
          "ডোবা": {
            "rate": 8625,
            "p": true
          }
        }
      },
      "মগধরা": {
        "rates": {
          "নাল": {
            "rate": 9975
          },
          "বাড়ী": {
            "rate": 31121
          },
          "ভিটা": {
            "rate": 31121
          },
          "বাগান": {
            "rate": 42437
          },
          "পুকুর": {
            "rate": 24850
          },
          "ডোবা": {
            "rate": 32836
          }
        }
      },
      "মাইটভাঙ্গা": {
        "rates": {
          "নাল": {
            "rate": 18111
          },
          "বাড়ী": {
            "rate": 36354
          },
          "ভিটা": {
            "rate": 36354
          },
          "বাগান": {
            "rate": 81646
          },
          "পুকুর": {
            "rate": 45726
          },
          "ডোবা": {
            "rate": 27323
          }
        }
      },
      "মুছাপুর": {
        "rates": {
          "নাল": {
            "rate": 22852
          },
          "বাড়ী": {
            "rate": 41187
          },
          "ভিটা": {
            "rate": 41187
          },
          "বাগান": {
            "rate": 37169
          },
          "পুকুর": {
            "rate": 37888
          },
          "ডোবা": {
            "rate": 52241
          }
        }
      },
      "রহমতপুর": {
        "rates": {
          "নাল": {
            "rate": 24767
          },
          "বাড়ী": {
            "rate": 28800
          },
          "ভিটা": {
            "rate": 28800
          },
          "বাগান": {
            "rate": 47964
          },
          "পুকুর": {
            "rate": 11576
          },
          "ডোবা": {
            "rate": 11384
          }
        },
        "pouroPukur": 51600
      },
      "সন্তোষপুর": {
        "rates": {
          "নাল": {
            "rate": 26632
          },
          "বাড়ী": {
            "rate": 43210
          },
          "ভিটা": {
            "rate": 43210
          },
          "বাগান": {
            "rate": 48255
          },
          "পুকুর": {
            "rate": 39927
          },
          "ডোবা": {
            "rate": 41181
          }
        }
      },
      "সন্তোষপুর (চর)": {
        "rates": {
          "নাল": {
            "rate": 14114
          },
          "বাড়ী": {
            "rate": 37277
          },
          "ভিটা": {
            "rate": 37277
          },
          "বাগান": {
            "rate": 50162
          },
          "পুকুর": {
            "rate": 21481
          },
          "ডোবা": {
            "rate": 43371
          }
        }
      },
      "সন্তোষপুর (বাক)": {
        "rates": {
          "নাল": {
            "rate": 11004
          },
          "বাড়ী": {
            "rate": 6051,
            "p": true
          },
          "ভিটা": {
            "rate": 6051,
            "p": true
          },
          "বাগান": {
            "rate": 3321,
            "p": true
          },
          "পুকুর": {
            "rate": 4701
          },
          "ডোবা": {
            "rate": 7500,
            "p": true
          }
        }
      },
      "সাতঘরিয়া": {
        "rates": {
          "নাল": {
            "rate": 18159
          },
          "বাড়ী": {
            "rate": 66612
          },
          "ভিটা": {
            "rate": 66612
          },
          "বাগান": {
            "rate": 55702
          },
          "পুকুর": {
            "rate": 28468
          },
          "ডোবা": {
            "rate": 28303
          }
        }
      },
      "সারিকাইত": {
        "rates": {
          "নাল": {
            "rate": 10959
          },
          "বাড়ী": {
            "rate": 58096
          },
          "ভিটা": {
            "rate": 58096
          },
          "বাগান": {
            "rate": 10286
          },
          "পুকুর": {
            "rate": 11968
          },
          "ডোবা": {
            "rate": 21946
          }
        }
      },
      "হরিশপুর": {
        "rates": {
          "নাল": {
            "rate": 20283
          },
          "বাড়ী": {
            "rate": 51645
          },
          "ভিটা": {
            "rate": 51645
          },
          "বাগান": {
            "rate": 38564
          },
          "পুকুর": {
            "rate": 58718
          },
          "ডোবা": {
            "rate": 27361
          }
        },
        "pouroPukur": 36441
      },
      "হরামিয়া": {
        "rates": {
          "নাল": {
            "rate": 52059
          },
          "বাড়ী": {
            "rate": 83380
          },
          "ভিটা": {
            "rate": 83380
          },
          "বাগান": {
            "rate": 137381
          },
          "পুকুর": {
            "rate": 45188
          },
          "ডোবা": {
            "rate": 91087
          }
        },
        "pouroPukur": 63257
      },
      "ছদ্রাখালী": {
        "rates": {
          "নাল": {
            "rate": 670,
            "p": true
          },
          "বাড়ী": {
            "rate": 1005,
            "p": true
          },
          "ভিটা": {
            "rate": 1005,
            "p": true
          },
          "বাগান": {
            "rate": 837,
            "p": true
          },
          "পুকুর": {
            "rate": 1306,
            "p": true
          }
        }
      },
      "ছদ্রাখালী (চর)": {
        "rates": {
          "নাল": {
            "rate": 1502
          },
          "বাড়ী": {
            "rate": 1770
          },
          "ভিটা": {
            "rate": 1770
          },
          "বাগান": {
            "rate": 1000
          },
          "পুকুর": {
            "rate": 2354
          }
        }
      },
      "ছদ্রাখালী (বাক)": {
        "rates": {
          "নাল": {
            "rate": 625,
            "p": true
          },
          "বাড়ী": {
            "rate": 407,
            "p": true
          },
          "ভিটা": {
            "rate": 407,
            "p": true
          },
          "বাগান": {
            "rate": 781,
            "p": true
          },
          "পুকুর": {
            "rate": 488,
            "p": true
          }
        }
      }
    }
  },
  gachbaria: {
    "name": "গাছবাড়িয়া, চন্দনাইশ",
    "period": "2025-2026",
    "mouzas": {
      "উত্তর জোয়ারা": {
        "rates": {
          "নাল": {
            "rate": 105269
          },
          "বাড়ী": {
            "rate": 260479
          },
          "ভিটা": {
            "rate": 131013
          },
          "বাগান": {
            "rate": 29735
          },
          "পুকুর": {
            "rate": 245688
          },
          "ডোবা": {
            "rate": 80182
          }
        }
      },
      "উত্তর কেশবা": {
        "rates": {
          "নাল": {
            "rate": 115076
          },
          "বাড়ী": {
            "rate": 99258
          },
          "ভিটা": {
            "rate": 170284
          },
          "বাগান": {
            "rate": 81000
          },
          "পুকুর": {
            "rate": 346441
          },
          "ডোবা": {
            "rate": 110625
          }
        }
      },
      "উত্তর আটিয়া": {
        "rates": {
          "নাল": {
            "rate": 18629
          },
          "ভিটা": {
            "rate": 6000,
            "p": true
          },
          "পুকুর": {
            "rate": 1000,
            "p": true
          }
        }
      },
      "কাঞ্চননগর": {
        "rates": {
          "নাল": {
            "rate": 179278
          },
          "বাড়ী": {
            "rate": 158573
          },
          "ভিটা": {
            "rate": 83333
          },
          "বাগান": {
            "rate": 75000
          },
          "পুকুর": {
            "rate": 153774
          }
        }
      },
      "কানাইমাদারী": {
        "rates": {
          "নাল": {
            "rate": 61340
          },
          "বাড়ী": {
            "rate": 78125
          },
          "ভিটা": {
            "rate": 65176
          },
          "বাগান": {
            "rate": 10000,
            "p": true
          },
          "পুকুর": {
            "rate": 70117
          }
        }
      },
      "কেওচিয়া": {
        "rates": {
          "নাল": {
            "rate": 10000,
            "p": true
          },
          "ভিটা": {
            "rate": 12000,
            "p": true
          },
          "পুকুর": {
            "rate": 1545,
            "p": true
          }
        }
      },
      "কুলাল চেন্না": {
        "rates": {
          "নাল": {
            "rate": 91334
          },
          "বাড়ী": {
            "rate": 151316
          },
          "ভিটা": {
            "rate": 470000
          },
          "বাগান": {
            "rate": 60920
          },
          "পুকুর": {
            "rate": 41942
          }
        }
      },
      "গাছবাড়ীয়া": {
        "rates": {
          "নাল": {
            "rate": 241958
          },
          "বাড়ী": {
            "rate": 316255
          },
          "ভিটা": {
            "rate": 81881
          },
          "বাগান": {
            "rate": 439825
          },
          "পুকুর": {
            "rate": 242291
          }
        }
      },
      "চন্দনাইশ": {
        "rates": {
          "নাল": {
            "rate": 206864
          },
          "বাড়ী": {
            "rate": 326073
          },
          "ভিটা": {
            "rate": 268881
          },
          "বাগান": {
            "rate": 880109
          },
          "পুকুর": {
            "rate": 149142
          }
        }
      },
      "চর বরমা": {
        "rates": {
          "নাল": {
            "rate": 1541,
            "p": true
          },
          "ভিটা": {
            "rate": 2000,
            "p": true
          },
          "পুকুর": {
            "rate": 1150,
            "p": true
          }
        }
      },
      "চাগাচর": {
        "rates": {
          "নাল": {
            "rate": 279005
          },
          "বাড়ী": {
            "rate": 284837
          },
          "ভিটা": {
            "rate": 103350
          },
          "বাগান": {
            "rate": 80488
          },
          "পুকুর": {
            "rate": 364285
          },
          "ডোবা": {
            "rate": 81829
          }
        }
      },
      "চিরিংঘাটি": {
        "rates": {
          "নাল": {
            "rate": 28068
          },
          "বাড়ী": {
            "rate": 157180
          },
          "ভিটা": {
            "rate": 7863,
            "p": true
          },
          "বাগান": {
            "rate": 3871,
            "p": true
          },
          "পুকুর": {
            "rate": 7452,
            "p": true
          }
        }
      },
      "জঙ্গল হাশিমপুর": {
        "rates": {
          "নাল": {
            "rate": 3200,
            "p": true
          },
          "ভিটা": {
            "rate": 5000,
            "p": true
          },
          "বাগান": {
            "rate": 25000,
            "p": true
          },
          "পুকুর": {
            "rate": 3000,
            "p": true
          }
        }
      },
      "জাফরাবাদ": {
        "rates": {
          "নাল": {
            "rate": 125479
          },
          "বাড়ী": {
            "rate": 162555
          },
          "ভিটা": {
            "rate": 274500
          },
          "বাগান": {
            "rate": 10634
          },
          "পুকুর": {
            "rate": 115434
          },
          "ডোবা": {
            "rate": 25000,
            "p": true
          }
        }
      },
      "জামিরজুরী": {
        "rates": {
          "নাল": {
            "rate": 93360
          },
          "বাড়ী": {
            "rate": 274446
          },
          "ভিটা": {
            "rate": 202666
          },
          "বাগান": {
            "rate": 1000000
          },
          "পুকুর": {
            "rate": 146310
          }
        }
      },
      "দক্ষিণ জোয়ারা": {
        "rates": {
          "নাল": {
            "rate": 66627
          },
          "বাড়ী": {
            "rate": 131579
          },
          "ভিটা": {
            "rate": 88000
          },
          "বাগান": {
            "rate": 131579
          },
          "পুকুর": {
            "rate": 97745
          }
        }
      },
      "দঃ আড়াদিঘা": {
        "rates": {
          "নাল": {
            "rate": 82843
          },
          "বাড়ী": {
            "rate": 74237
          },
          "ভিটা": {
            "rate": 30000
          },
          "বাগান": {
            "rate": 68750
          },
          "পুকুর": {
            "rate": 4333,
            "p": true
          },
          "ডোবা": {
            "rate": 3333,
            "p": true
          }
        }
      },
      "দোহাজারী": {
        "rates": {
          "নাল": {
            "rate": 327374
          },
          "বাড়ী": {
            "rate": 400126
          },
          "ভিটা": {
            "rate": 72066,
            "p": true
          },
          "বাগান": {
            "rate": 104167
          },
          "পুকুর": {
            "rate": 233642
          },
          "ডোবা": {
            "rate": 333334
          }
        }
      },
      "শিয়াজুরী": {
        "rates": {
          "নাল": {
            "rate": 51855
          },
          "বাড়ী": {
            "rate": 92229
          },
          "ভিটা": {
            "rate": 50000,
            "p": true
          },
          "বাগান": {
            "rate": 14530,
            "p": true
          },
          "পুকুর": {
            "rate": 5334,
            "p": true
          },
          "ডোবা": {
            "rate": 20000,
            "p": true
          }
        }
      },
      "পাটা জোড়া": {
        "rates": {
          "নাল": {
            "rate": 1380,
            "p": true
          },
          "ভিটা": {
            "rate": 15000,
            "p": true
          },
          "পুকুর": {
            "rate": 1400,
            "p": true
          }
        }
      },
      "পূর্ব এলাহাবাদ": {
        "rates": {
          "নাল": {
            "rate": 56685
          },
          "বাড়ী": {
            "rate": 700000
          },
          "ভিটা": {
            "rate": 45361
          },
          "বাগান": {
            "rate": 40000,
            "p": true
          },
          "পুকুর": {
            "rate": 58424
          }
        }
      },
      "পশ্চিম এলাহাবাদ": {
        "rates": {
          "নাল": {
            "rate": 278905
          },
          "বাড়ী": {
            "rate": 300000
          },
          "ভিটা": {
            "rate": 15245,
            "p": true
          },
          "বাগান": {
            "rate": 40625
          },
          "পুকুর": {
            "rate": 148614
          }
        }
      },
      "পূর্ব গোপালঘাটি": {
        "rates": {
          "নাল": {
            "rate": 19388
          },
          "বাড়ী": {
            "rate": 11809
          },
          "ভিটা": {
            "rate": 4213,
            "p": true
          },
          "বাগান": {
            "rate": 9913,
            "p": true
          },
          "পুকুর": {
            "rate": 7153
          },
          "ডোবা": {
            "rate": 4400,
            "p": true
          }
        }
      },
      "পশ্চিম গোপালঘাটি": {
        "rates": {
          "নাল": {
            "rate": 34272
          },
          "বাড়ী": {
            "rate": 23139
          },
          "ভিটা": {
            "rate": 25000,
            "p": true
          },
          "বাগান": {
            "rate": 50000,
            "p": true
          },
          "পুকুর": {
            "rate": 857,
            "p": true
          }
        }
      },
      "কতলপুর": {
        "rates": {
          "নাল": {
            "rate": 16877
          },
          "বাড়ী": {
            "rate": 90182
          },
          "ভিটা": {
            "rate": 11538
          },
          "পুকুর": {
            "rate": 5042
          }
        }
      },
      "পাটিলদহ": {
        "rates": {
          "নাল": {
            "rate": 42835
          },
          "বাড়ী": {
            "rate": 68226
          },
          "ভিটা": {
            "rate": 37840
          },
          "বাগান": {
            "rate": 3912,
            "p": true
          },
          "পুকুর": {
            "rate": 58375
          },
          "ডোবা": {
            "rate": 106837
          }
        }
      },
      "বরকল": {
        "rates": {
          "নাল": {
            "rate": 128654
          },
          "বাড়ী": {
            "rate": 97680
          },
          "ভিটা": {
            "rate": 244117
          },
          "বাগান": {
            "rate": 32254,
            "p": true
          },
          "পুকুর": {
            "rate": 95613
          }
        }
      },
      "বরমা": {
        "rates": {
          "নাল": {
            "rate": 79674
          },
          "বাড়ী": {
            "rate": 25442
          },
          "ভিটা": {
            "rate": 6000,
            "p": true
          },
          "পুকুর": {
            "rate": 25661,
            "p": true
          }
        }
      },
      "বলরাম নগর": {
        "rates": {
          "নাল": {
            "rate": 50187
          },
          "বাড়ী": {
            "rate": 111377
          },
          "ভিটা": {
            "rate": 12000,
            "p": true
          },
          "বাগান": {
            "rate": 5000,
            "p": true
          },
          "পুকুর": {
            "rate": 1212,
            "p": true
          }
        }
      },
      "বাইনজুরী": {
        "rates": {
          "নাল": {
            "rate": 114027
          },
          "বাড়ী": {
            "rate": 90857
          },
          "ভিটা": {
            "rate": 129167
          },
          "বাগান": {
            "rate": 139940
          },
          "পুকুর": {
            "rate": 147072
          }
        }
      },
      "বাতাজুরী": {
        "rates": {
          "নাল": {
            "rate": 40423
          },
          "বাড়ী": {
            "rate": 104253
          },
          "ভিটা": {
            "rate": 20062,
            "p": true
          },
          "বাগান": {
            "rate": 30894,
            "p": true
          },
          "পুকুর": {
            "rate": 38544
          }
        }
      },
      "বৈলতলী": {
        "rates": {
          "নাল": {
            "rate": 86965
          },
          "বাড়ী": {
            "rate": 124312
          },
          "ভিটা": {
            "rate": 122401
          },
          "বাগান": {
            "rate": 11396
          },
          "পুকুর": {
            "rate": 95214
          },
          "ডোবা": {
            "rate": 123799
          }
        }
      },
      "মাইসাতা": {
        "rates": {
          "নাল": {
            "rate": 55930
          },
          "বাড়ী": {
            "rate": 128778
          },
          "ভিটা": {
            "rate": 107792
          },
          "বাগান": {
            "rate": 5000,
            "p": true
          },
          "পুকুর": {
            "rate": 67968
          }
        }
      },
      "মোহাম্মদপুর": {
        "rates": {
          "নাল": {
            "rate": 376450
          },
          "বাড়ী": {
            "rate": 187642
          },
          "ভিটা": {
            "rate": 105000,
            "p": true
          },
          "পুকুর": {
            "rate": 150622
          }
        }
      },
      "মোহাম্মদবালী": {
        "rates": {
          "নাল": {
            "rate": 60419
          },
          "বাড়ী": {
            "rate": 125000
          },
          "ভিটা": {
            "rate": 150000
          },
          "বাগান": {
            "rate": 121200,
            "p": true
          },
          "পুকুর": {
            "rate": 27412,
            "p": true
          },
          "ডোবা": {
            "rate": 20618,
            "p": true
          }
        }
      },
      "মুরাদাবাদ": {
        "rates": {
          "নাল": {
            "rate": 103405
          },
          "বাড়ী": {
            "rate": 79868
          },
          "ভিটা": {
            "rate": 64327,
            "p": true
          },
          "বাগান": {
            "rate": 14889,
            "p": true
          },
          "পুকুর": {
            "rate": 77785
          },
          "ডোবা": {
            "rate": 32637,
            "p": true
          }
        }
      },
      "রামজোয়ারা": {
        "rates": {
          "নাল": {
            "rate": 115333
          },
          "বাড়ী": {
            "rate": 135398
          },
          "ভিটা": {
            "rate": 30000,
            "p": true
          },
          "বাগান": {
            "rate": 50000
          },
          "পুকুর": {
            "rate": 73600
          }
        }
      },
      "ছোট কাঞ্চন": {
        "rates": {
          "নাল": {
            "rate": 9857,
            "p": true
          },
          "ভিটা": {
            "rate": 10000,
            "p": true
          },
          "পুকুর": {
            "rate": 800,
            "p": true
          }
        }
      },
      "শোলকী": {
        "rates": {
          "নাল": {
            "rate": 49735
          },
          "বাড়ী": {
            "rate": 216338
          },
          "ভিটা": {
            "rate": 60049,
            "p": true
          },
          "বাগান": {
            "rate": 23333,
            "p": true
          },
          "পুকুর": {
            "rate": 184869
          },
          "ডোবা": {
            "rate": 81579,
            "p": true
          }
        }
      },
      "সাতবাড়িয়া": {
        "rates": {
          "নাল": {
            "rate": 104998
          },
          "বাড়ী": {
            "rate": 160562
          },
          "ভিটা": {
            "rate": 102727
          },
          "বাগান": {
            "rate": 119323,
            "p": true
          },
          "পুকুর": {
            "rate": 86148
          },
          "ডোবা": {
            "rate": 150309
          }
        }
      },
      "হাশিমপুর": {
        "rates": {
          "নাল": {
            "rate": 92106
          },
          "বাড়ী": {
            "rate": 199212
          },
          "ভিটা": {
            "rate": 156872
          },
          "বাগান": {
            "rate": 150000
          },
          "পুকুর": {
            "rate": 192444
          },
          "ডোবা": {
            "rate": 65503,
            "p": true
          }
        }
      },
      "হরলা": {
        "rates": {
          "নাল": {
            "rate": 55531
          },
          "বাড়ী": {
            "rate": 144838
          },
          "ভিটা": {
            "rate": 340516
          },
          "বাগান": {
            "rate": 22079
          },
          "পুকুর": {
            "rate": 72494
          }
        }
      },
      "হাহন্দী": {
        "rates": {
          "নাল": {
            "rate": 87504
          },
          "বাড়ী": {
            "rate": 151116
          },
          "ভিটা": {
            "rate": 100000,
            "p": true
          },
          "বাগান": {
            "rate": 50000
          },
          "পুকুর": {
            "rate": 90985
          }
        }
      },
      "হাতিয়ার খোলা": {
        "rates": {
          "নাল": {
            "rate": 17874
          },
          "বাড়ী": {
            "rate": 7000,
            "p": true
          },
          "ভিটা": {
            "rate": 5000,
            "p": true
          },
          "বাগান": {
            "rate": 46155
          },
          "পুকুর": {
            "rate": 925,
            "p": true
          }
        }
      }
    }
  },
  rangunia: {
    "name": "রাঙ্গুনিয়া",
    "period": "2025-2026",
    "mouzas": {
      "আন্দর ঘোনা": {
        "rates": {
          "নাল": {
            "rate": 52921
          },
          "ভিটা": {
            "rate": 52921
          },
          "বাগান": {
            "rate": 7126
          },
          "পুকুর": {
            "rate": 2542,
            "p": true
          },
          "ডোবা": {
            "rate": 850,
            "p": true
          }
        }
      },
      "ইছামতি": {
        "rates": {
          "নাল": {
            "rate": 9572
          },
          "ভিটা": {
            "rate": 116026
          },
          "পুকুর": {
            "rate": 103217
          },
          "ডোবা": {
            "rate": 137500
          }
        }
      },
      "উত্তর ঘাগড়া": {
        "rates": {
          "নাল": {
            "rate": 37406
          },
          "ভিটা": {
            "rate": 37406
          },
          "বাগান": {
            "rate": 15680
          },
          "পুকুর": {
            "rate": 855,
            "p": true
          },
          "ডোবা": {
            "rate": 400,
            "p": true
          }
        }
      },
      "কদমতলী": {
        "rates": {
          "নাল": {
            "rate": 123198
          },
          "ভিটা": {
            "rate": 255090
          },
          "বাগান": {
            "rate": 93750
          },
          "পুকুর": {
            "rate": 128643
          },
          "ডোবা": {
            "rate": 91044
          }
        }
      },
      "কাউখালী": {
        "rates": {
          "নাল": {
            "rate": 97151
          },
          "ভিটা": {
            "rate": 97151
          },
          "বাগান": {
            "rate": 85585
          },
          "পুকুর": {
            "rate": 59993
          },
          "ডোবা": {
            "rate": 8750,
            "p": true
          }
        }
      },
      "কাটাখালী": {
        "rates": {
          "নাল": {
            "rate": 174789
          },
          "ভিটা": {
            "rate": 325586
          },
          "পুকুর": {
            "rate": 183007
          },
          "ডোবা": {
            "rate": 187698
          }
        }
      },
      "কোদালা": {
        "rates": {
          "নাল": {
            "rate": 79034
          },
          "ভিটা": {
            "rate": 130199
          },
          "বাগান": {
            "rate": 208824
          },
          "পুকুর": {
            "rate": 173307
          },
          "ডোবা": {
            "rate": 65693
          }
        }
      },
      "কোকানিয়া": {
        "rates": {
          "নাল": {
            "rate": 63184
          },
          "ভিটা": {
            "rate": 63184
          },
          "পুকুর": {
            "rate": 52233
          },
          "ডোবা": {
            "rate": 1111,
            "p": true
          }
        }
      },
      "খারগোলা": {
        "rates": {
          "নাল": {
            "rate": 68579
          },
          "ভিটা": {
            "rate": 68579
          },
          "পুকুর": {
            "rate": 54840
          },
          "ডোবা": {
            "rate": 4190,
            "p": true
          }
        }
      },
      "গজালিয়া": {
        "rates": {
          "নাল": {
            "rate": 41791
          },
          "ভিটা": {
            "rate": 100000
          },
          "পুকুর": {
            "rate": 43798
          },
          "ডোবা": {
            "rate": 500,
            "p": true
          }
        }
      },
      "গুনগুনিয়া বেতাগী": {
        "rates": {
          "নাল": {
            "rate": 102990
          },
          "ভিটা": {
            "rate": 143333
          },
          "পুকুর": {
            "rate": 37425
          },
          "ডোবা": {
            "rate": 19355,
            "p": true
          }
        }
      },
      "গুমাইবিল": {
        "rates": {
          "নাল": {
            "rate": 36990
          },
          "ভিটা": {
            "rate": 80853
          },
          "বাগান": {
            "rate": 107027
          },
          "পুকুর": {
            "rate": 550,
            "p": true
          },
          "ডোবা": {
            "rate": 13846
          }
        }
      },
      "গুমাই": {
        "rates": {
          "নাল": {
            "rate": 42176
          },
          "ভিটা": {
            "rate": 52869,
            "p": true
          },
          "পুকুর": {
            "rate": 17314
          },
          "ডোবা": {
            "rate": 312500
          }
        }
      },
      "ঘাটচেক": {
        "rates": {
          "নাল": {
            "rate": 224442
          },
          "ভিটা": {
            "rate": 362854
          },
          "বাগান": {
            "rate": 194000,
            "p": true
          },
          "পুকুর": {
            "rate": 240336
          },
          "ডোবা": {
            "rate": 103250
          }
        }
      },
      "চন্দ্রঘোনা": {
        "rates": {
          "নাল": {
            "rate": 37741
          },
          "ভিটা": {
            "rate": 843340
          },
          "বাগান": {
            "rate": 160000
          },
          "পুকুর": {
            "rate": 45358
          },
          "ডোবা": {
            "rate": 141070
          }
        }
      },
      "চেংখালী": {
        "rates": {
          "নাল": {
            "rate": 74522
          },
          "ভিটা": {
            "rate": 74522
          },
          "পুকুর": {
            "rate": 1588,
            "p": true
          },
          "ডোবা": {
            "rate": 800,
            "p": true
          }
        }
      },
      "জঙ্গল পাকুয়া": {
        "rates": {
          "নাল": {
            "rate": 25212
          },
          "ভিটা": {
            "rate": 41226,
            "p": true
          },
          "পুকুর": {
            "rate": 100000
          },
          "ডোবা": {
            "rate": 550,
            "p": true
          }
        }
      },
      "জঙ্গল সরকভাটা": {
        "rates": {
          "নাল": {
            "rate": 41447
          },
          "ভিটা": {
            "rate": 41447
          },
          "পুকুর": {
            "rate": 500,
            "p": true
          },
          "ডোবা": {
            "rate": 500,
            "p": true
          }
        }
      },
      "জঙ্গল ঘাটচেক": {
        "rates": {
          "নাল": {
            "rate": 176856
          },
          "ভিটা": {
            "rate": 625000
          },
          "বাগান": {
            "rate": 100000,
            "p": true
          },
          "পুকুর": {
            "rate": 1000,
            "p": true
          },
          "ডোবা": {
            "rate": 3443,
            "p": true
          }
        }
      },
      "জঙ্গল দক্ষিণ নিশ্চিন্তপুর": {
        "rates": {
          "নাল": {
            "rate": 201586
          },
          "ভিটা": {
            "rate": 201586
          },
          "বাগান": {
            "rate": 35000
          },
          "পুকুর": {
            "rate": 550,
            "p": true
          },
          "ডোবা": {
            "rate": 574,
            "p": true
          }
        }
      },
      "জঙ্গল পোমরা": {
        "rates": {
          "নাল": {
            "rate": 77383
          },
          "ভিটা": {
            "rate": 77383
          },
          "বাগান": {
            "rate": 34546
          },
          "পুকুর": {
            "rate": 550,
            "p": true
          },
          "ডোবা": {
            "rate": 550,
            "p": true
          }
        }
      },
      "জঙ্গল সুরত সিংহের ঢালা": {
        "rates": {
          "নাল": {
            "rate": 13792
          },
          "ভিটা": {
            "rate": 13792
          },
          "বাগান": {
            "rate": 32609,
            "p": true
          },
          "পুকুর": {
            "rate": 500,
            "p": true
          },
          "ডোবা": {
            "rate": 500,
            "p": true
          }
        }
      },
      "জঙ্গল বগাবিল": {
        "rates": {
          "নাল": {
            "rate": 11696
          },
          "ভিটা": {
            "rate": 11696
          },
          "পুকুর": {
            "rate": 350,
            "p": true
          },
          "ডোবা": {
            "rate": 350,
            "p": true
          }
        }
      },
      "ঠাণ্ডাছড়ি": {
        "rates": {
          "নাল": {
            "rate": 99797
          },
          "ভিটা": {
            "rate": 99797
          },
          "পুকুর": {
            "rate": 400,
            "p": true
          },
          "ডোবা": {
            "rate": 400,
            "p": true
          }
        }
      },
      "ডিঙ্গল গোপা": {
        "rates": {
          "নাল": {
            "rate": 73261
          },
          "ভিটা": {
            "rate": 169837
          },
          "পুকুর": {
            "rate": 136881
          },
          "ডোবা": {
            "rate": 83333,
            "p": true
          }
        }
      },
      "টেমির ছড়া": {
        "rates": {
          "নাল": {
            "rate": 48927
          },
          "ভিটা": {
            "rate": 118667
          },
          "বাগান": {
            "rate": 117000
          },
          "পুকুর": {
            "rate": 27744
          },
          "ডোবা": {
            "rate": 42241,
            "p": true
          }
        }
      },
      "তিনচৌদিয়া": {
        "rates": {
          "নাল": {
            "rate": 60027
          },
          "ভিটা": {
            "rate": 350000
          },
          "পুকুর": {
            "rate": 150433
          },
          "ডোবা": {
            "rate": 50000
          }
        }
      },
      "ত্রিপুরা সুন্দরী": {
        "rates": {
          "নাল": {
            "rate": 23157
          },
          "ভিটা": {
            "rate": 97741
          },
          "পুকুর": {
            "rate": 50000
          },
          "ডোবা": {
            "rate": 400,
            "p": true
          }
        }
      },
      "তৈলাভাঙ্গা": {
        "rates": {
          "নাল": {
            "rate": 31026
          },
          "ভিটা": {
            "rate": 31026
          },
          "পুকুর": {
            "rate": 385
          },
          "ডোবা": {
            "rate": 667
          }
        }
      },
      "দক্ষিণ নিশ্চিন্তপুর": {
        "rates": {
          "নাল": {
            "rate": 47322
          },
          "ভিটা": {
            "rate": 128566
          },
          "বাগান": {
            "rate": 34000,
            "p": true
          },
          "পুকুর": {
            "rate": 154277
          },
          "ডোবা": {
            "rate": 100000,
            "p": true
          }
        }
      },
      "দক্ষিণ ঘাগড়া": {
        "rates": {
          "নাল": {
            "rate": 94010
          },
          "ভিটা": {
            "rate": 221874
          },
          "বাগান": {
            "rate": 557986
          },
          "পুকুর": {
            "rate": 118445
          },
          "ডোবা": {
            "rate": 110378
          }
        }
      },
      "দক্ষিণ ইছামতি": {
        "rates": {
          "নাল": {
            "rate": 95013
          },
          "ভিটা": {
            "rate": 129505
          },
          "পুকুর": {
            "rate": 136170
          },
          "ডোবা": {
            "rate": 1707,
            "p": true
          }
        }
      },
      "দক্ষিণ পাকুয়া": {
        "rates": {
          "নাল": {
            "rate": 69005
          },
          "ভিটা": {
            "rate": 69005
          },
          "ডোবা": {
            "rate": 10557,
            "p": true
          }
        }
      },
      "ঘারিকোপ": {
        "rates": {
          "নাল": {
            "rate": 29347
          },
          "ভিটা": {
            "rate": 34803
          },
          "পুকুর": {
            "rate": 53500,
            "p": true
          },
          "ডোবা": {
            "rate": 5018,
            "p": true
          }
        }
      },
      "দুধ পুকুরিয়া": {
        "rates": {
          "নাল": {
            "rate": 11700
          },
          "ভিটা": {
            "rate": 11700
          },
          "পুকুর": {
            "rate": 7000,
            "p": true
          },
          "ডোবা": {
            "rate": 250,
            "p": true
          }
        }
      },
      "দেবীপুর কদমতলী": {
        "rates": {
          "নাল": {
            "rate": 56555
          },
          "ভিটা": {
            "rate": 56555
          },
          "পুকুর": {
            "rate": 950,
            "p": true
          },
          "ডোবা": {
            "rate": 3704,
            "p": true
          }
        }
      },
      "ধোপাঘাটা": {
        "rates": {
          "নাল": {
            "rate": 93519
          },
          "ভিটা": {
            "rate": 163973
          },
          "বাগান": {
            "rate": 52083,
            "p": true
          },
          "পুকুর": {
            "rate": 86333,
            "p": true
          },
          "ডোবা": {
            "rate": 102231,
            "p": true
          }
        }
      },
      "নারিচা": {
        "rates": {
          "নাল": {
            "rate": 52135
          },
          "ভিটা": {
            "rate": 110024
          },
          "পুকুর": {
            "rate": 59000
          },
          "ডোবা": {
            "rate": 53750,
            "p": true
          }
        }
      },
      "নাপিত পুকুরিয়া": {
        "rates": {
          "নাল": {
            "rate": 20588
          },
          "ভিটা": {
            "rate": 33821
          },
          "পুকুর": {
            "rate": 1579,
            "p": true
          },
          "ডোবা": {
            "rate": 4000,
            "p": true
          }
        }
      },
      "নোয়াগাঁও": {
        "rates": {
          "নাল": {
            "rate": 181914
          },
          "ভিটা": {
            "rate": 235681
          },
          "বাগান": {
            "rate": 136000
          },
          "পুকুর": {
            "rate": 147384
          },
          "ডোবা": {
            "rate": 126000,
            "p": true
          }
        }
      },
      "পদুয়া": {
        "rates": {
          "নাল": {
            "rate": 45185
          },
          "ভিটা": {
            "rate": 81478
          },
          "বাগান": {
            "rate": 15000
          },
          "পুকুর": {
            "rate": 198556
          },
          "ডোবা": {
            "rate": 33813
          }
        }
      },
      "পশ্চিম নিশ্চিন্তপুর": {
        "rates": {
          "নাল": {
            "rate": 80453
          },
          "ভিটা": {
            "rate": 172554
          },
          "বাগান": {
            "rate": 124333,
            "p": true
          },
          "পুকুর": {
            "rate": 15871
          },
          "ডোবা": {
            "rate": 13974
          }
        }
      },
      "পারকুয়া": {
        "rates": {
          "নাল": {
            "rate": 53195
          },
          "ভিটা": {
            "rate": 113402
          },
          "পুকুর": {
            "rate": 87625
          },
          "ডোবা": {
            "rate": 110690
          }
        }
      },
      "পশ্চিম বুরশিয়া": {
        "rates": {
          "নাল": {
            "rate": 18604
          },
          "ভিটা": {
            "rate": 25950
          },
          "বাগান": {
            "rate": 33334
          },
          "পুকুর": {
            "rate": 31646
          },
          "ডোবা": {
            "rate": 1428,
            "p": true
          }
        }
      },
      "পুকুরিয়া গোলা": {
        "rates": {
          "নাল": {
            "rate": 7502,
            "p": true
          },
          "ভিটা": {
            "rate": 7502
          },
          "পুকুর": {
            "rate": 550,
            "p": true
          },
          "ডোবা": {
            "rate": 550,
            "p": true
          }
        }
      },
      "পূর্ব বুরশিয়া": {
        "rates": {
          "নাল": {
            "rate": 20856
          },
          "ভিটা": {
            "rate": 33517
          },
          "পুকুর": {
            "rate": 113208
          },
          "ডোবা": {
            "rate": 2500,
            "p": true
          }
        }
      },
      "পূর্ব নিশ্চিন্তপুর": {
        "rates": {
          "নাল": {
            "rate": 27078
          },
          "ভিটা": {
            "rate": 150000,
            "p": true
          },
          "বাগান": {
            "rate": 39535,
            "p": true
          },
          "পুকুর": {
            "rate": 60091
          },
          "ডোবা": {
            "rate": 500,
            "p": true
          }
        }
      },
      "পোমরা": {
        "rates": {
          "নাল": {
            "rate": 158896
          },
          "ভিটা": {
            "rate": 262475
          },
          "বাগান": {
            "rate": 207273
          },
          "পুকুর": {
            "rate": 180673
          },
          "ডোবা": {
            "rate": 297740
          }
        }
      },
      "কলাহারিয়া": {
        "rates": {
          "নাল": {
            "rate": 11763
          },
          "ভিটা": {
            "rate": 2578,
            "p": true
          },
          "পুকুর": {
            "rate": 2350,
            "p": true
          },
          "ডোবা": {
            "rate": 24331,
            "p": true
          }
        }
      },
      "বগাবিল": {
        "rates": {
          "নাল": {
            "rate": 26895
          },
          "ভিটা": {
            "rate": 87339
          },
          "বাগান": {
            "rate": 33375
          },
          "পুকুর": {
            "rate": 33908
          },
          "ডোবা": {
            "rate": 30250,
            "p": true
          }
        }
      },
      "বানিয়া খোলা": {
        "rates": {
          "নাল": {
            "rate": 18605
          },
          "ভিটা": {
            "rate": 18605
          },
          "পুকুর": {
            "rate": 7500,
            "p": true
          },
          "ডোবা": {
            "rate": 1050,
            "p": true
          }
        }
      },
      "বাইনলা": {
        "rates": {
          "নাল": {
            "rate": 28630
          },
          "ভিটা": {
            "rate": 28630
          },
          "পুকুর": {
            "rate": 200,
            "p": true
          },
          "ডোবা": {
            "rate": 200,
            "p": true
          }
        }
      },
      "বেতাগী": {
        "rates": {
          "নাল": {
            "rate": 56711
          },
          "ভিটা": {
            "rate": 151909
          },
          "বাগান": {
            "rate": 75598
          },
          "পুকুর": {
            "rate": 81348
          },
          "ডোবা": {
            "rate": 80222
          }
        }
      },
      "ভবনছড়া": {
        "rates": {
          "নাল": {
            "rate": 76763
          },
          "ভিটা": {
            "rate": 76763
          },
          "পুকুর": {
            "rate": 6180,
            "p": true
          },
          "ডোবা": {
            "rate": 9091
          }
        }
      },
      "মধ্য ঘাগড়া": {
        "rates": {
          "নাল": {
            "rate": 132332
          },
          "ভিটা": {
            "rate": 183336
          },
          "বাগান": {
            "rate": 40486
          },
          "পুকুর": {
            "rate": 99022
          },
          "ডোবা": {
            "rate": 224000
          }
        }
      },
      "মেঘাছড়ি": {
        "rates": {
          "নাল": {
            "rate": 12440
          },
          "ভিটা": {
            "rate": 20000,
            "p": true
          },
          "পুকুর": {
            "rate": 2244,
            "p": true
          },
          "ডোবা": {
            "rate": 350,
            "p": true
          }
        }
      },
      "রাঙ্গুনিয়া": {
        "rates": {
          "নাল": {
            "rate": 11928
          },
          "ভিটা": {
            "rate": 309385
          },
          "বাগান": {
            "rate": 274667
          },
          "পুকুর": {
            "rate": 111827
          },
          "ডোবা": {
            "rate": 275298
          }
        }
      },
      "লট-২ কোদালা": {
        "rates": {
          "নাল": {
            "rate": 19583
          },
          "ভিটা": {
            "rate": 33334,
            "p": true
          },
          "পুকুর": {
            "rate": 2705,
            "p": true
          },
          "ডোবা": {
            "rate": 500,
            "p": true
          }
        }
      },
      "লট-৫ জঙ্গল কোদালা": {
        "rates": {
          "নাল": {
            "rate": 43597
          },
          "ভিটা": {
            "rate": 43597
          },
          "পুকুর": {
            "rate": 5000,
            "p": true
          },
          "ডোবা": {
            "rate": 350,
            "p": true
          }
        }
      },
      "লট কোদালা": {
        "rates": {
          "নাল": {
            "rate": 700,
            "p": true
          },
          "ভিটা": {
            "rate": 700
          },
          "পুকুর": {
            "rate": 600,
            "p": true
          },
          "ডোবা": {
            "rate": 600,
            "p": true
          }
        }
      },
      "লট-৫৮ নিশ্চিন্তপুর": {
        "rates": {
          "নাল": {
            "rate": 3665
          },
          "ভিটা": {
            "rate": 3665
          }
        }
      },
      "লালনগর": {
        "rates": {
          "নাল": {
            "rate": 181174
          },
          "ভিটা": {
            "rate": 181174
          },
          "পুকুর": {
            "rate": 94672
          },
          "ডোবা": {
            "rate": 89939
          }
        }
      },
      "শিলক": {
        "rates": {
          "নাল": {
            "rate": 93014
          },
          "ভিটা": {
            "rate": 200859
          },
          "বাগান": {
            "rate": 377471
          },
          "পুকুর": {
            "rate": 110674
          },
          "ডোবা": {
            "rate": 251231
          }
        }
      },
      "শিয়াল বুড়া": {
        "rates": {
          "নাল": {
            "rate": 30435
          },
          "ভিটা": {
            "rate": 100435
          },
          "বাগান": {
            "rate": 30000,
            "p": true
          },
          "পুকুর": {
            "rate": 75676
          },
          "ডোবা": {
            "rate": 650,
            "p": true
          }
        }
      },
      "ভরত সিংহের ঢালা": {
        "rates": {
          "নাল": {
            "rate": 12364
          },
          "ভিটা": {
            "rate": 12364
          },
          "বাগান": {
            "rate": 155333
          },
          "পুকুর": {
            "rate": 500,
            "p": true
          },
          "ডোবা": {
            "rate": 500,
            "p": true
          }
        }
      },
      "সরফভাটা": {
        "rates": {
          "নাল": {
            "rate": 148510
          },
          "ভিটা": {
            "rate": 291873
          },
          "বাগান": {
            "rate": 705064
          },
          "পুকুর": {
            "rate": 150533
          },
          "ডোবা": {
            "rate": 258520
          }
        }
      },
      "সুবিলাস": {
        "rates": {
          "নাল": {
            "rate": 22853
          },
          "ভিটা": {
            "rate": 38635
          },
          "বাগান": {
            "rate": 33444
          },
          "পুকুর": {
            "rate": 83618
          },
          "ডোবা": {
            "rate": 41985,
            "p": true
          }
        }
      },
      "সৈয়দবাড়ী": {
        "rates": {
          "নাল": {
            "rate": 361736
          },
          "ভিটা": {
            "rate": 433546
          },
          "পুকুর": {
            "rate": 238499
          },
          "ডোবা": {
            "rate": 25000,
            "p": true
          }
        }
      },
      "সোনাইছড়ি": {
        "rates": {
          "নাল": {
            "rate": 18666
          },
          "ভিটা": {
            "rate": 18666
          },
          "পুকুর": {
            "rate": 3333,
            "p": true
          },
          "ডোবা": {
            "rate": 450,
            "p": true
          }
        }
      },
      "হোসনাবাদ": {
        "rates": {
          "নাল": {
            "rate": 136282
          },
          "ভিটা": {
            "rate": 162680
          },
          "বাগান": {
            "rate": 75000,
            "p": true
          },
          "পুকুর": {
            "rate": 13414
          },
          "ডোবা": {
            "rate": 88739
          }
        }
      },
      "লট-৫৭ ঠাণ্ডাছড়ি": {
        "rates": {
          "নাল": {
            "rate": 54140,
            "p": true
          },
          "ভিটা": {
            "rate": 125000
          }
        }
      },
      "লট-৪৭ হাজারী": {
        "rates": {
          "নাল": {
            "rate": 2463,
            "p": true
          },
          "ভিটা": {
            "rate": 2463
          }
        }
      }
    }
  },
  pahartali: {
    "name": "পাহাড়তলী",
    "period": "2025-2026",
    "mouzas": {
      "লতিফপুর": {
        "rates": {
          "নাল": {
            "rate": 514650
          },
          "বাড়ী": {
            "rate": 1020651
          },
          "ভিটা": {
            "rate": 1020651
          },
          "পুকুর": {
            "rate": 300000,
            "p": true
          }
        },
        "jl": "64"
      },
      "উত্তর কাট্টলী": {
        "rates": {
          "নাল": {
            "rate": 544977
          },
          "বাড়ী": {
            "rate": 1155675
          },
          "ভিটা": {
            "rate": 1155675
          },
          "বাগান": {
            "rate": 904598,
            "p": true
          },
          "পুকুর": {
            "rate": 563007
          },
          "ডোবা": {
            "rate": 844000
          }
        },
        "jl": "01"
      },
      "উত্তর পাহাড়তলী": {
        "rates": {
          "নাল": {
            "rate": 680287
          },
          "বাড়ী": {
            "rate": 1540398
          },
          "ভিটা": {
            "rate": 1540398
          },
          "বাগান": {
            "rate": 349774
          },
          "পুকুর": {
            "rate": 968299
          }
        },
        "jl": "04"
      },
      "লট-৯ পাহাড়তলী": {
        "rates": {
          "নাল": {
            "rate": 632510
          },
          "বাড়ী": {
            "rate": 1764525
          },
          "ভিটা": {
            "rate": 1764525
          },
          "বাগান": {
            "rate": 533660
          },
          "পুকুর": {
            "rate": 283889
          }
        },
        "jl": "05"
      },
      "দক্ষিণ কাট্টলী": {
        "rates": {
          "নাল": {
            "rate": 578016
          },
          "বাড়ী": {
            "rate": 1289380
          },
          "ভিটা": {
            "rate": 1289380
          },
          "বাগান": {
            "rate": 485075
          },
          "পুকুর": {
            "rate": 644575
          },
          "ডোবা": {
            "rate": 698925
          }
        },
        "jl": "02"
      },
      "সরাইপাড়া": {
        "rates": {
          "নাল": {
            "rate": 804915
          },
          "বাড়ী": {
            "rate": 1564094
          },
          "ভিটা": {
            "rate": 1564094
          },
          "বাগান": {
            "rate": 680000,
            "p": true
          },
          "পুকুর": {
            "rate": 1052634
          }
        },
        "jl": "03"
      },
      "দক্ষিণ পাহাড়তলী": {
        "rates": {
          "নাল": {
            "rate": 506371
          },
          "বাড়ী": {
            "rate": 1316316
          },
          "ভিটা": {
            "rate": 1316316
          },
          "বাগান": {
            "rate": 370000
          },
          "পুকুর": {
            "rate": 559701
          },
          "ডোবা": {
            "rate": 515370
          }
        },
        "jl": "06"
      },
      "পশ্চিম নাছিরাবাদ": {
        "rates": {
          "নাল": {
            "rate": 1440342
          },
          "বাড়ী": {
            "rate": 2384927
          },
          "ভিটা": {
            "rate": 2384927
          },
          "বাগান": {
            "rate": 2028986,
            "p": true
          },
          "পুকুর": {
            "rate": 1070406
          }
        },
        "jl": "07"
      },
      "রামপুর": {
        "rates": {
          "নাল": {
            "rate": 1397789
          },
          "বাড়ী": {
            "rate": 1717905
          },
          "ভিটা": {
            "rate": 1717905
          },
          "পুকুর": {
            "rate": 644714
          },
          "ডোবা": {
            "rate": 1712062
          }
        },
        "jl": "08"
      },
      "উত্তর হালিশহর": {
        "rates": {
          "নাল": {
            "rate": 450756
          },
          "বাড়ী": {
            "rate": 1302831
          },
          "ভিটা": {
            "rate": 1302831
          },
          "বাগান": {
            "rate": 1191824
          },
          "পুকুর": {
            "rate": 586313
          }
        },
        "jl": "09"
      },
      "নলশা": {
        "rates": {
          "নাল": {
            "rate": 250000,
            "p": true
          },
          "বাড়ী": {
            "rate": 1375672
          },
          "ভিটা": {
            "rate": 1375672
          },
          "পুকুর": {
            "rate": 562389,
            "p": true
          }
        },
        "jl": "18"
      }
    }
  },
  adhunagar: {
    "name": "আধুনগর, লোহাগাড়া",
    "period": "2025-2026",
    "mouzas": {
      "আধুনগর": {
        "rates": {
          "নাল": {"rate": 109212},
          "ভিটা": {"rate": 132183},
          "বাগান": {"rate": 82833},
          "পুকুর": {"rate": 78471},
          "ডোবা": {"rate": 3789}
        },
        "jl": "10"
      },
      "আমিরাবাদ": {
        "rates": {
          "নাল": {"rate": 308235},
          "ভিটা": {"rate": 613473},
          "বাগান": {"rate": 148921},
          "পুকুর": {"rate": 205259},
          "ডোবা": {"rate": 59549}
        },
        "jl": "22"
      },
      "আমতলী": {
        "rates": {
          "নাল": {"rate": 58918},
          "ভিটা": {"rate": 107436},
          "বাগান": {"rate": 47058},
          "পুকুর": {"rate": 89119},
          "ডোবা": {"rate": 2750}
        },
        "jl": "09"
      },
      "আদার চর": {
        "rates": {
          "নাল": {"rate": 69359},
          "ভিটা": {"rate": 24461},
          "বাগান": {"rate": 32373},
          "পুকুর": {"rate": 41666},
          "ডোবা": {"rate": 4769}
        },
        "jl": "34"
      },
      "আঁধার মানিক": {
        "rates": {
          "নাল": {"rate": 47021},
          "ভিটা": {"rate": 74422},
          "বাগান": {"rate": 15151},
          "পুকুর": {"rate": 63620},
          "ডোবা": {"rate": 1833}
        },
        "jl": "30"
      },
      "উত্তর কলাউজান": {
        "rates": {
          "নাল": {"rate": 101853},
          "ভিটা": {"rate": 108046},
          "বাগান": {"rate": 25931},
          "পুকুর": {"rate": 106706},
          "ডোবা": {"rate": 95000}
        },
        "jl": "20"
      },
      "কুলপাগলী": {
        "rates": {
          "নাল": {"rate": 48139},
          "ভিটা": {"rate": 30298},
          "বাগান": {"rate": 2050},
          "পুকুর": {"rate": 9595}
        },
        "jl": "07"
      },
      "গোরস্থান": {
        "rates": {
          "নাল": {"rate": 52363},
          "ভিটা": {"rate": 55369},
          "বাগান": {"rate": 17060},
          "পুকুর": {"rate": 65357},
          "ডোবা": {"rate": 10000}
        },
        "jl": "39"
      },
      "চরঘা": {
        "rates": {
          "নাল": {"rate": 48073},
          "ভিটা": {"rate": 49882},
          "বাগান": {"rate": 38536},
          "পুকুর": {"rate": 95134},
          "ডোবা": {"rate": 41176}
        },
        "jl": "31"
      },
      "চারফিরানী": {
        "rates": {
          "নাল": {"rate": 55948},
          "ভিটা": {"rate": 125762},
          "বাগান": {"rate": 44080},
          "পুকুর": {"rate": 48222},
          "ডোবা": {"rate": 2647}
        },
        "jl": "03"
      },
      "চাঁন্দা": {
        "rates": {
          "নাল": {"rate": 40121},
          "ভিটা": {"rate": 32696},
          "বাগান": {"rate": 148426},
          "পুকুর": {"rate": 20000},
          "ডোবা": {"rate": 1400}
        },
        "jl": "13"
      },
      "চুনতি": {
        "rates": {
          "নাল": {"rate": 99287},
          "ভিটা": {"rate": 126126},
          "বাগান": {"rate": 123552},
          "পুকুর": {"rate": 108260},
          "ডোবা": {"rate": 105089}
        },
        "jl": "06"
      },
      "জঙ্গল পদুয়া": {
        "rates": {
          "নাল": {"rate": 18982},
          "ভিটা": {"rate": 82702},
          "বাগান": {"rate": 9987},
          "পুকুর": {"rate": 45679},
          "ডোবা": {"rate": 3000}
        },
        "jl": "28"
      },
      "জঙ্গল রশিদেরঘোনা": {
        "rates": {
          "নাল": {"rate": 3334},
          "বাগান": {"rate": 3225}
        },
        "jl": "04"
      },
      "জঙ্গল বড়হাতিয়া": {
        "rates": {
          "নাল": {"rate": 5555}
        },
        "jl": "01"
      },
      "জঙ্গল চুনতি": {
        "rates": {
          "নাল": {"rate": 5000}
        },
        "jl": "05"
      },
      "তেলিকিলা": {
        "rates": {
          "নাল": {"rate": 75724},
          "ভিটা": {"rate": 27282},
          "বাগান": {"rate": 8895},
          "পুকুর": {"rate": 11538},
          "ডোবা": {"rate": 2250}
        },
        "jl": "26"
      },
      "দক্ষিণ পুটিবিলা": {
        "rates": {
          "নাল": {"rate": 74473},
          "ভিটা": {"rate": 129623},
          "বাগান": {"rate": 39449},
          "পুকুর": {"rate": 83414},
          "ডোবা": {"rate": 24609}
        },
        "jl": "17"
      },
      "দক্ষিণ সুখছড়ী": {
        "rates": {
          "নাল": {"rate": 107016},
          "ভিটা": {"rate": 173518},
          "বাগান": {"rate": 114127},
          "পুকুর": {"rate": 146861},
          "ডোবা": {"rate": 3750}
        },
        "jl": "18"
      },
      "ধলিবিলা": {
        "rates": {
          "নাল": {"rate": 22181},
          "ভিটা": {"rate": 25597},
          "বাগান": {"rate": 9907},
          "পুকুর": {"rate": 22038},
          "ডোবা": {"rate": 80000}
        },
        "jl": "29"
      },
      "নারিশ্চা": {
        "rates": {
          "নাল": {"rate": 40184},
          "ভিটা": {"rate": 47575},
          "বাগান": {"rate": 66666},
          "পুকুর": {"rate": 61310},
          "ডোবা": {"rate": 2000}
        },
        "jl": "14"
      },
      "নোয়ারবিলা": {
        "rates": {
          "নাল": {"rate": 64358},
          "ভিটা": {"rate": 62003},
          "বাগান": {"rate": 32781},
          "পুকুর": {"rate": 38124},
          "ডোবা": {"rate": 2900}
        },
        "jl": "35"
      },
      "পশ্চিম কলাউজান": {
        "rates": {
          "নাল": {"rate": 88101},
          "ভিটা": {"rate": 86560},
          "বাগান": {"rate": 40000},
          "পুকুর": {"rate": 87962},
          "ডোবা": {"rate": 2433}
        },
        "jl": "19"
      },
      "পদুয়া": {
        "rates": {
          "নাল": {"rate": 140485},
          "ভিটা": {"rate": 171525},
          "বাগান": {"rate": 98230},
          "পুকুর": {"rate": 172896},
          "ডোবা": {"rate": 35329}
        },
        "jl": "27"
      },
      "পহর চান্দা": {
        "rates": {
          "নাল": {"rate": 20674},
          "ভিটা": {"rate": 51771},
          "বাগান": {"rate": 7250},
          "পুকুর": {"rate": 31286}
        },
        "jl": "38"
      },
      "পানত্রিশা": {
        "rates": {
          "নাল": {"rate": 41855},
          "ভিটা": {"rate": 31785},
          "বাগান": {"rate": 22818},
          "পুকুর": {"rate": 23385},
          "ডোবা": {"rate": 1909}
        },
        "jl": "16"
      },
      "পূর্ব কলাউজান": {
        "rates": {
          "নাল": {"rate": 72732},
          "ভিটা": {"rate": 119797},
          "বাগান": {"rate": 50000},
          "পুকুর": {"rate": 69722},
          "ডোবা": {"rate": 4687}
        },
        "jl": "37"
      },
      "ফারেঙ্গা": {
        "rates": {
          "নাল": {"rate": 20003},
          "ভিটা": {"rate": 23819},
          "বাগান": {"rate": 20333},
          "পুকুর": {"rate": 14222}
        },
        "jl": "15"
      },
      "বড়হাতিয়া": {
        "rates": {
          "নাল": {"rate": 98442},
          "ভিটা": {"rate": 182619},
          "বাগান": {"rate": 71986},
          "পুকুর": {"rate": 127506},
          "ডোবা": {"rate": 2381}
        },
        "jl": "02"
      },
      "বিবিরবিলা": {
        "rates": {
          "নাল": {"rate": 53649},
          "ভিটা": {"rate": 60609},
          "বাগান": {"rate": 43208},
          "পুকুর": {"rate": 54436},
          "ডোবা": {"rate": 3333}
        },
        "jl": "33"
      },
      "মলিক ছোয়াং": {
        "rates": {
          "নাল": {"rate": 148410},
          "ভিটা": {"rate": 217944},
          "বাগান": {"rate": 100000},
          "পুকুর": {"rate": 79921},
          "ডোবা": {"rate": 27488}
        },
        "jl": "23"
      },
      "মাইজ বিলা": {
        "rates": {
          "নাল": {"rate": 60199},
          "ভিটা": {"rate": 65720},
          "বাগান": {"rate": 23524},
          "পুকুর": {"rate": 99096},
          "ডোবা": {"rate": 3666}
        },
        "jl": "32"
      },
      "রশিদেরঘোনা": {
        "rates": {
          "নাল": {"rate": 33744},
          "ভিটা": {"rate": 43091},
          "বাগান": {"rate": 75049},
          "পুকুর": {"rate": 110903},
          "ডোবা": {"rate": 48669}
        },
        "jl": "08"
      },
      "রাজঘাটা": {
        "rates": {
          "নাল": {"rate": 36340},
          "ভিটা": {"rate": 64302},
          "বাগান": {"rate": 32352},
          "পুকুর": {"rate": 37056},
          "ডোবা": {"rate": 1550}
        },
        "jl": "36"
      },
      "লোহাগাড়া": {
        "rates": {
          "নাল": {"rate": 507436},
          "ভিটা": {"rate": 352059},
          "বাগান": {"rate": 941379},
          "পুকুর": {"rate": 286944},
          "ডোবা": {"rate": 5094}
        },
        "jl": "21"
      },
      "সড়াইয়া": {
        "rates": {
          "নাল": {"rate": 18854},
          "ভিটা": {"rate": 39861},
          "বাগান": {"rate": 7560},
          "পুকুর": {"rate": 27044}
        },
        "jl": "40"
      },
      "সাতগড়": {
        "rates": {
          "নাল": {"rate": 76025},
          "ভিটা": {"rate": 134439},
          "বাগান": {"rate": 81012},
          "পুকুর": {"rate": 100517},
          "ডোবা": {"rate": 1666}
        },
        "jl": "11"
      },
      "সুখছড়ী": {
        "rates": {
          "নাল": {"rate": 132119},
          "ভিটা": {"rate": 133506},
          "বাগান": {"rate": 82772},
          "পুকুর": {"rate": 87793},
          "ডোবা": {"rate": 3647}
        },
        "jl": "25"
      },
      "হরিণা": {
        "rates": {
          "নাল": {"rate": 83107},
          "ভিটা": {"rate": 78256},
          "বাগান": {"rate": 5000},
          "পুকুর": {"rate": 111234},
          "ডোবা": {"rate": 4185}
        },
        "jl": "12"
      },
      "হাজারবিঘা": {
        "rates": {
          "নাল": {"rate": 83494},
          "ভিটা": {"rate": 97361},
          "বাগান": {"rate": 4285},
          "পুকুর": {"rate": 60233},
          "ডোবা": {"rate": 78313}
        },
        "jl": "24"
      }
    }
  },
  banshkhali: {
    "name": "বাঁশখালী",
    "period": "2025-2026",
    "mouzas": {
      "উত্তর জলদী (পৌর)": {
        "rates": {
          "নাল": {"rate": 181667},
          "বাড়ী": {"rate": 437905},
          "ভিটা": {"rate": 437905},
          "বাগান": {"rate": 247021},
          "পুকুর": {"rate": 447704},
          "ডোবা": {"rate": 447704}
        }
      },
      "দক্ষিণ জলদী (পৌর)": {
        "rates": {
          "নাল": {"rate": 187479},
          "বাড়ী": {"rate": 391310},
          "ভিটা": {"rate": 391310},
          "বাগান": {"rate": 331187},
          "পুকুর": {"rate": 227063},
          "ডোবা": {"rate": 227063}
        }
      },
      "জঙ্গল জলদী (পৌর)": {
        "rates": {
          "নাল": {"rate": 58248},
          "বাড়ী": {"rate": 72000},
          "ভিটা": {"rate": 72000},
          "বাগান": {"rate": 72973},
          "পুকুর": {"rate": 22000},
          "ডোবা": {"rate": 22000}
        }
      },
      "উত্তর জলদী (সাবেক)": {
        "rates": {
          "নাল": {"rate": 9553},
          "বাড়ী": {"rate": 18620},
          "ভিটা": {"rate": 18620},
          "পুকুর": {"rate": 8202},
          "ডোবা": {"rate": 8202}
        }
      },
      "দক্ষিণ জলদী (সাবেক)": {
        "rates": {
          "নাল": {"rate": 42984},
          "বাড়ী": {"rate": 10724},
          "ভিটা": {"rate": 10724},
          "বাগান": {"rate": 3000},
          "পুকুর": {"rate": 13649},
          "ডোবা": {"rate": 13649}
        }
      },
      "জঙ্গল জলদী (সাবেক)": {
        "rates": {
          "নাল": {"rate": 50304},
          "বাড়ী": {"rate": 12857},
          "ভিটা": {"rate": 12857},
          "পুকুর": {"rate": 4000},
          "ডোবা": {"rate": 4000}
        }
      },
      "আলকদিয়া": {
        "rates": {
          "নাল": {"rate": 67447},
          "বাড়ী": {"rate": 3150},
          "ভিটা": {"rate": 3150},
          "পুকুর": {"rate": 300000},
          "ডোবা": {"rate": 300000}
        }
      },
      "ইলশা": {
        "rates": {
          "নাল": {"rate": 49440},
          "বাড়ী": {"rate": 84248},
          "ভিটা": {"rate": 84248},
          "পুকুর": {"rate": 42661},
          "ডোবা": {"rate": 42661}
        }
      },
      "কোকদন্ডী": {
        "rates": {
          "নাল": {"rate": 184853},
          "বাড়ী": {"rate": 512388},
          "ভিটা": {"rate": 512388},
          "বাগান": {"rate": 104000},
          "পুকুর": {"rate": 150524},
          "ডোবা": {"rate": 150524}
        }
      },
      "কালীপুর": {
        "rates": {
          "নাল": {"rate": 70293},
          "বাড়ী": {"rate": 160574},
          "ভিটা": {"rate": 160574},
          "বাগান": {"rate": 123302},
          "পুকুর": {"rate": 210930},
          "ডোবা": {"rate": 210930}
        }
      },
      "কোটপাড়া": {
        "rates": {
          "নাল": {"rate": 35159},
          "বাড়ী": {"rate": 23000},
          "ভিটা": {"rate": 23000},
          "পুকুর": {"rate": 10000},
          "ডোবা": {"rate": 10000}
        }
      },
      "কাহারঘোনা": {
        "rates": {
          "নাল": {"rate": 62103},
          "বাড়ী": {"rate": 92542},
          "ভিটা": {"rate": 92542},
          "পুকুর": {"rate": 48814},
          "ডোবা": {"rate": 48814}
        }
      },
      "কাথারিয়া": {
        "rates": {
          "নাল": {"rate": 47871},
          "বাড়ী": {"rate": 38786},
          "ভিটা": {"rate": 38786},
          "বাগান": {"rate": 44444},
          "পুকুর": {"rate": 65422},
          "ডোবা": {"rate": 65422}
        }
      },
      "খুদুকখালী": {
        "rates": {
          "নাল": {"rate": 29483},
          "বাড়ী": {"rate": 47416},
          "ভিটা": {"rate": 47416},
          "পুকুর": {"rate": 32372},
          "ডোবা": {"rate": 32372}
        }
      },
      "খোদমোজাফফরাবাদ": {
        "rates": {
          "নাল": {"rate": 1560},
          "বাড়ী": {"rate": 2500},
          "ভিটা": {"rate": 2500},
          "পুকুর": {"rate": 30303},
          "ডোবা": {"rate": 30303}
        }
      },
      "খানখানাবাদ": {
        "rates": {
          "নাল": {"rate": 32483},
          "বাড়ী": {"rate": 2427},
          "ভিটা": {"rate": 2427},
          "পুকুর": {"rate": 14000},
          "ডোবা": {"rate": 14000}
        }
      },
      "গন্ডামারা": {
        "rates": {
          "নাল": {"rate": 55535},
          "বাড়ী": {"rate": 51620},
          "ভিটা": {"rate": 51620},
          "পুকুর": {"rate": 50281},
          "ডোবা": {"rate": 50281}
        }
      },
      "গুনাগরী": {
        "rates": {
          "নাল": {"rate": 114003},
          "বাড়ী": {"rate": 187512},
          "ভিটা": {"rate": 187512},
          "পুকুর": {"rate": 116579},
          "ডোবা": {"rate": 116579}
        }
      },
      "চর-বড়ঘোনা": {
        "rates": {
          "নাল": {"rate": 67264},
          "বাড়ী": {"rate": 6250},
          "ভিটা": {"rate": 6250},
          "পুকুর": {"rate": 1250},
          "ডোবা": {"rate": 1250}
        }
      },
      "চম্পপুর": {
        "rates": {
          "নাল": {"rate": 69293},
          "বাড়ী": {"rate": 67139},
          "ভিটা": {"rate": 67139},
          "বাগান": {"rate": 197110},
          "পুকুর": {"rate": 65574},
          "ডোবা": {"rate": 65574}
        }
      },
      "চাঁদপুর/চালদপুর": {
        "rates": {
          "নাল": {"rate": 82875},
          "বাড়ী": {"rate": 109129},
          "ভিটা": {"rate": 109129},
          "বাগান": {"rate": 24000},
          "পুকুর": {"rate": 172675},
          "ডোবা": {"rate": 172675}
        }
      },
      "চরজুইডভী": {
        "rates": {
          "নাল": {"rate": 10296},
          "বাড়ী": {"rate": 11421},
          "ভিটা": {"rate": 11421},
          "পুকুর": {"rate": 1450},
          "ডোবা": {"rate": 1450}
        }
      },
      "চেচুরিয়া": {
        "rates": {
          "নাল": {"rate": 97963},
          "বাড়ী": {"rate": 125508},
          "ভিটা": {"rate": 125508},
          "বাগান": {"rate": 168426},
          "পুকুর": {"rate": 148594},
          "ডোবা": {"rate": 148594}
        }
      },
      "চাপাছড়ী": {
        "rates": {
          "নাল": {"rate": 45387},
          "বাড়ী": {"rate": 59766},
          "ভিটা": {"rate": 59766},
          "পুকুর": {"rate": 43630},
          "ডোবা": {"rate": 43630}
        }
      },
      "ছোট ছনুয়া": {
        "rates": {
          "নাল": {"rate": 23639},
          "বাড়ী": {"rate": 31428},
          "ভিটা": {"rate": 31428},
          "পুকুর": {"rate": 18215},
          "ডোবা": {"rate": 18215}
        }
      },
      "জালিয়াঘাটা": {
        "rates": {
          "নাল": {"rate": 62450},
          "বাড়ী": {"rate": 901863},
          "ভিটা": {"rate": 901863},
          "পুকুর": {"rate": 139686},
          "ডোবা": {"rate": 139686}
        }
      },
      "জঙ্গল সাধনপুর": {
        "rates": {
          "নাল": {"rate": 89975},
          "বাড়ী": {"rate": 32000},
          "ভিটা": {"rate": 32000},
          "পুকুর": {"rate": 7000},
          "ডোবা": {"rate": 7000}
        }
      },
      "জঙ্গল ছনাগরী": {
        "rates": {
          "নাল": {"rate": 101940},
          "বাড়ী": {"rate": 439130},
          "ভিটা": {"rate": 439130},
          "বাগান": {"rate": 55114},
          "পুকুর": {"rate": 83733},
          "ডোবা": {"rate": 83733}
        }
      },
      "জঙ্গল কোকদন্ডী": {
        "rates": {
          "নাল": {"rate": 110626},
          "বাড়ী": {"rate": 193733},
          "ভিটা": {"rate": 193733},
          "বাগান": {"rate": 150000},
          "পুকুর": {"rate": 57941},
          "ডোবা": {"rate": 57941}
        }
      },
      "জঙ্গল কালীপুর": {
        "rates": {
          "নাল": {"rate": 48503},
          "বাড়ী": {"rate": 121313},
          "ভিটা": {"rate": 121313},
          "বাগান": {"rate": 44994},
          "পুকুর": {"rate": 1300},
          "ডোবা": {"rate": 1300}
        }
      },
      "জঙ্গল বৈলছড়ী": {
        "rates": {
          "নাল": {"rate": 27638},
          "বাড়ী": {"rate": 17000},
          "ভিটা": {"rate": 17000},
          "বাগান": {"rate": 4717},
          "পুকুর": {"rate": 1300},
          "ডোবা": {"rate": 1300}
        }
      },
      "জঙ্গল শিলকূপ": {
        "rates": {
          "নাল": {"rate": 47072},
          "বাড়ী": {"rate": 11200},
          "ভিটা": {"rate": 11200},
          "বাগান": {"rate": 91167},
          "পুকুর": {"rate": 1400},
          "ডোবা": {"rate": 1400}
        }
      },
      "জঙ্গল চেচুরিয়া": {
        "rates": {
          "নাল": {"rate": 6000},
          "বাড়ী": {"rate": 4100},
          "ভিটা": {"rate": 4100},
          "বাগান": {"rate": 13178},
          "পুকুর": {"rate": 1300},
          "ডোবা": {"rate": 1300}
        }
      },
      "জঙ্গল চাপল": {
        "rates": {
          "নাল": {"rate": 40881},
          "বাড়ী": {"rate": 19242},
          "ভিটা": {"rate": 19242},
          "বাগান": {"rate": 26484},
          "পুকুর": {"rate": 1100},
          "ডোবা": {"rate": 1100}
        }
      },
      "জঙ্গল নাপোড়া": {
        "rates": {
          "নাল": {"rate": 26784},
          "বাড়ী": {"rate": 32130},
          "ভিটা": {"rate": 32130},
          "বাগান": {"rate": 10294},
          "পুকুর": {"rate": 1500},
          "ডোবা": {"rate": 1500}
        }
      },
      "জঙ্গল পাইরাং": {
        "rates": {
          "নাল": {"rate": 43426},
          "বাড়ী": {"rate": 48484},
          "ভিটা": {"rate": 48484},
          "বাগান": {"rate": 32875},
          "পুকুর": {"rate": 53852},
          "ডোবা": {"rate": 53852}
        }
      },
      "জঙ্গল পুঁইছড়ী": {
        "rates": {
          "নাল": {"rate": 32450},
          "বাড়ী": {"rate": 301863},
          "ভিটা": {"rate": 301863},
          "বাগান": {"rate": 57124},
          "পুকুর": {"rate": 54146},
          "ডোবা": {"rate": 54146}
        }
      },
      "ডেমরা": {
        "rates": {
          "নাল": {"rate": 38868},
          "বাড়ী": {"rate": 39554},
          "ভিটা": {"rate": 39554},
          "পুকুর": {"rate": 32218},
          "ডোবা": {"rate": 32218}
        }
      },
      "দক্ষিণ বড়মছড়া": {
        "rates": {
          "নাল": {"rate": 54851},
          "বাড়ী": {"rate": 65325},
          "ভিটা": {"rate": 65325},
          "বাগান": {"rate": 71429},
          "পুকুর": {"rate": 107993},
          "ডোবা": {"rate": 107993}
        }
      },
      "ধাইয়া": {
        "rates": {
          "নাল": {"rate": 29678},
          "বাড়ী": {"rate": 12000},
          "ভিটা": {"rate": 12000},
          "পুকুর": {"rate": 8463},
          "ডোবা": {"rate": 8463}
        }
      },
      "নাপোড়া": {
        "rates": {
          "নাল": {"rate": 81031},
          "বাড়ী": {"rate": 75871},
          "ভিটা": {"rate": 75871},
          "বাগান": {"rate": 18780},
          "পুকুর": {"rate": 43342},
          "ডোবা": {"rate": 43342}
        }
      },
      "নাটমূড়া": {
        "rates": {
          "নাল": {"rate": 72492},
          "বাড়ী": {"rate": 126586},
          "ভিটা": {"rate": 126586},
          "বাগান": {"rate": 100000},
          "পুকুর": {"rate": 156864},
          "ডোবা": {"rate": 156864}
        }
      },
      "পালেহাম": {
        "rates": {
          "নাল": {"rate": 88504},
          "বাড়ী": {"rate": 231696},
          "ভিটা": {"rate": 231696},
          "বাগান": {"rate": 317472},
          "পুকুর": {"rate": 75857},
          "ডোবা": {"rate": 75857}
        }
      },
      "পাইরাং": {
        "rates": {
          "নাল": {"rate": 171307},
          "বাড়ী": {"rate": 128425},
          "ভিটা": {"rate": 128425},
          "বাগান": {"rate": 60000},
          "পুকুর": {"rate": 81763},
          "ডোবা": {"rate": 81763}
        }
      },
      "পূর্ব চাপল": {
        "rates": {
          "নাল": {"rate": 104787},
          "বাড়ী": {"rate": 122068},
          "ভিটা": {"rate": 122068},
          "বাগান": {"rate": 114272},
          "পুকুর": {"rate": 104394},
          "ডোবা": {"rate": 104394}
        }
      },
      "পশ্চিম চাপল": {
        "rates": {
          "নাল": {"rate": 53604},
          "বাড়ী": {"rate": 154840},
          "ভিটা": {"rate": 154840},
          "বাগান": {"rate": 141509},
          "পুকুর": {"rate": 70254},
          "ডোবা": {"rate": 70254}
        }
      },
      "পূর্ব বড়ঘোনা": {
        "rates": {
          "নাল": {"rate": 40533},
          "বাড়ী": {"rate": 68228},
          "ভিটা": {"rate": 68228},
          "পুকুর": {"rate": 41948},
          "ডোবা": {"rate": 41948}
        }
      },
      "পশ্চিম বড়ঘোনা": {
        "rates": {
          "নাল": {"rate": 59513},
          "বাড়ী": {"rate": 53397},
          "ভিটা": {"rate": 53397},
          "পুকুর": {"rate": 65307},
          "ডোবা": {"rate": 65307}
        }
      },
      "পুঁইছড়ী": {
        "rates": {
          "নাল": {"rate": 58756},
          "বাড়ী": {"rate": 46358},
          "ভিটা": {"rate": 46358},
          "বাগান": {"rate": 6593},
          "পুকুর": {"rate": 38691},
          "ডোবা": {"rate": 38691}
        }
      },
      "প্রেমাশিয়া": {
        "rates": {
          "নাল": {"rate": 162227},
          "বাড়ী": {"rate": 17835},
          "ভিটা": {"rate": 17835},
          "পুকুর": {"rate": 46289},
          "ডোবা": {"rate": 46289}
        }
      },
      "পুকুরিয়া": {
        "rates": {
          "নাল": {"rate": 109919},
          "বাড়ী": {"rate": 177282},
          "ভিটা": {"rate": 177282},
          "বাগান": {"rate": 160532},
          "পুকুর": {"rate": 153240},
          "ডোবা": {"rate": 153240}
        }
      },
      "বাহারছড়া": {
        "rates": {
          "নাল": {"rate": 43771},
          "বাড়ী": {"rate": 89578},
          "ভিটা": {"rate": 89578},
          "পুকুর": {"rate": 42902},
          "ডোবা": {"rate": 42902}
        }
      },
      "বাঁশখালা": {
        "rates": {
          "নাল": {"rate": 30496},
          "বাড়ী": {"rate": 57650},
          "ভিটা": {"rate": 57650},
          "পুকুর": {"rate": 34776},
          "ডোবা": {"rate": 34776}
        }
      },
      "বাগমারা": {
        "rates": {
          "নাল": {"rate": 45297},
          "বাড়ী": {"rate": 37344},
          "ভিটা": {"rate": 37344},
          "পুকুর": {"rate": 13076},
          "ডোবা": {"rate": 13076}
        }
      },
      "বরইতলী": {
        "rates": {
          "নাল": {"rate": 56525},
          "বাড়ী": {"rate": 26562},
          "ভিটা": {"rate": 26562},
          "পুকুর": {"rate": 40121},
          "ডোবা": {"rate": 40121}
        }
      },
      "বৈলছড়ী": {
        "rates": {
          "নাল": {"rate": 80411},
          "বাড়ী": {"rate": 178612},
          "ভিটা": {"rate": 178612},
          "বাগান": {"rate": 100743},
          "পুকুর": {"rate": 234606},
          "ডোবা": {"rate": 234606}
        }
      },
      "বানীগ্রাম": {
        "rates": {
          "নাল": {"rate": 84502},
          "বাড়ী": {"rate": 189583},
          "ভিটা": {"rate": 189583},
          "বাগান": {"rate": 169333},
          "পুকুর": {"rate": 94887},
          "ডোবা": {"rate": 94887}
        }
      },
      "বৈলগাঁও": {
        "rates": {
          "নাল": {"rate": 44264},
          "বাড়ী": {"rate": 106794},
          "ভিটা": {"rate": 106794},
          "বাগান": {"rate": 44051},
          "পুকুর": {"rate": 104595},
          "ডোবা": {"rate": 104595}
        }
      },
      "ভোলামারা": {
        "rates": {
          "নাল": {"rate": 18130},
          "বাড়ী": {"rate": 61322},
          "ভিটা": {"rate": 61322},
          "পুকুর": {"rate": 20740},
          "ডোবা": {"rate": 20740}
        }
      },
      "মাইজপাড়া": {
        "rates": {
          "নাল": {"rate": 25099},
          "বাড়ী": {"rate": 9000},
          "ভিটা": {"rate": 9000},
          "পুকুর": {"rate": 16364},
          "ডোবা": {"rate": 16364}
        }
      },
      "মানিকপাঠান": {
        "rates": {
          "নাল": {"rate": 28588},
          "বাড়ী": {"rate": 38251},
          "ভিটা": {"rate": 38251},
          "পুকুর": {"rate": 24112},
          "ডোবা": {"rate": 24112}
        }
      },
      "মিনজীরতলা": {
        "rates": {
          "নাল": {"rate": 41947},
          "বাড়ী": {"rate": 81808},
          "ভিটা": {"rate": 81808},
          "বাগান": {"rate": 50000},
          "পুকুর": {"rate": 73985},
          "ডোবা": {"rate": 73985}
        }
      },
      "মনকিচর/মূলকিচর": {
        "rates": {
          "নাল": {"rate": 70221},
          "বাড়ী": {"rate": 76855},
          "ভিটা": {"rate": 76855},
          "পুকুর": {"rate": 66549},
          "ডোবা": {"rate": 66549}
        }
      },
      "রত্নপুর": {
        "rates": {
          "নাল": {"rate": 30957},
          "বাড়ী": {"rate": 41556},
          "ভিটা": {"rate": 41556},
          "পুকুর": {"rate": 36479},
          "ডোবা": {"rate": 36479}
        }
      },
      "রাতা": {
        "rates": {
          "নাল": {"rate": 5031},
          "বাড়ী": {"rate": 10467},
          "ভিটা": {"rate": 10467},
          "পুকুর": {"rate": 11000},
          "ডোবা": {"rate": 11000}
        }
      },
      "রায়ছটা": {
        "rates": {
          "নাল": {"rate": 20459},
          "বাড়ী": {"rate": 45494},
          "ভিটা": {"rate": 45494},
          "পুকুর": {"rate": 17364},
          "ডোবা": {"rate": 17364}
        }
      },
      "লটমনি": {
        "rates": {
          "নাল": {"rate": 33256},
          "বাড়ী": {"rate": 52778},
          "ভিটা": {"rate": 52778},
          "বাগান": {"rate": 245419},
          "পুকুর": {"rate": 113600},
          "ডোবা": {"rate": 113600}
        }
      },
      "লটহল": {
        "rates": {
          "নাল": {"rate": 82063},
          "বাড়ী": {"rate": 3500},
          "ভিটা": {"rate": 3500},
          "পুকুর": {"rate": 1300},
          "ডোবা": {"rate": 1300}
        }
      },
      "শীলকূপ": {
        "rates": {
          "নাল": {"rate": 109433},
          "বাড়ী": {"rate": 135122},
          "ভিটা": {"rate": 135122},
          "বাগান": {"rate": 16667},
          "পুকুর": {"rate": 109456},
          "ডোবা": {"rate": 109456}
        }
      },
      "শেখেরখীল": {
        "rates": {
          "নাল": {"rate": 59569},
          "বাড়ী": {"rate": 102678},
          "ভিটা": {"rate": 102678},
          "বাগান": {"rate": 50000},
          "পুকুর": {"rate": 54108},
          "ডোবা": {"rate": 54108}
        }
      },
      "সাধনপুর": {
        "rates": {
          "নাল": {"rate": 61726},
          "বাড়ী": {"rate": 127961},
          "ভিটা": {"rate": 127961},
          "বাগান": {"rate": 94846},
          "পুকুর": {"rate": 106702},
          "ডোবা": {"rate": 106702}
        }
      },
      "সরল": {
        "rates": {
          "নাল": {"rate": 35440},
          "বাড়ী": {"rate": 106136},
          "ভিটা": {"rate": 106136},
          "পুকুর": {"rate": 36520},
          "ডোবা": {"rate": 36520}
        }
      },
      "হাজীগাঁও": {
        "rates": {
          "নাল": {"rate": 53078},
          "বাড়ী": {"rate": 89384},
          "ভিটা": {"rate": 89384},
          "বাগান": {"rate": 97545},
          "পুকুর": {"rate": 52633},
          "ডোবা": {"rate": 52633}
        }
      },
      "হালিয়াপাড়া": {
        "rates": {
          "নাল": {"rate": 25246},
          "বাড়ী": {"rate": 5422},
          "ভিটা": {"rate": 5422},
          "পুকুর": {"rate": 14925},
          "ডোবা": {"rate": 14925}
        }
      }
    }
  },
  'ctg-sadar': {
    "name": "সদর (কোর্টহিল)",
    "period": "2025-2026",
    "mouzas": {
      "ফিরিঙ্গীবাজার": {
        "rates": {
          "নাল": {"rate": 818529},
          "বাড়ী": {"rate": 2156141},
          "ভিটা": {"rate": 2156141},
          "পুকুর": {"rate": 956216}
        },
        "jl": "20",
        "thana": "কোতোয়ালী"
      },
      "আন্দরকিল্লা": {
        "rates": {
          "বাড়ী": {"rate": 2893886},
          "ভিটা": {"rate": 2893886},
          "পুকুর": {"rate": 800000, "p": true}
        },
        "jl": "11",
        "thana": "কোতোয়ালী"
      },
      "রহমতগঞ্জ": {
        "rates": {
          "বাড়ী": {"rate": 2374755},
          "ভিটা": {"rate": 2374755},
          "পুকুর": {"rate": 450000, "p": true}
        },
        "jl": "12",
        "thana": "কোতোয়ালী"
      },
      "নিজ শহর": {
        "rates": {
          "বাড়ী": {"rate": 3056645},
          "ভিটা": {"rate": 3056645},
          "পুকুর": {"rate": 2056074}
        },
        "jl": "2",
        "thana": "কোতোয়ালী"
      },
      "নিজ শহর (শিল্প)": {
        "rates": {
          "বাড়ী": {"rate": 2511951, "p": true},
          "ভিটা": {"rate": 2511951, "p": true}
        },
        "jl": "2",
        "thana": "কোতোয়ালী"
      },
      "কাসিম বাজার": {
        "rates": {
          "বাড়ী": {"rate": 1640839},
          "ভিটা": {"rate": 1640839},
          "পুকুর": {"rate": 400000, "p": true}
        },
        "jl": "4",
        "thana": "কোতোয়ালী"
      },
      "চন্দনপুরা": {
        "rates": {
          "বাড়ী": {"rate": 2709229},
          "ভিটা": {"rate": 2709229},
          "পুকুর": {"rate": 563636}
        },
        "jl": "13",
        "thana": "কোতোয়ালী"
      },
      "পাথরঘাটা": {
        "rates": {
          "বাড়ী": {"rate": 2632132},
          "ভিটা": {"rate": 2632132},
          "পুকুর": {"rate": 803800}
        },
        "jl": "15",
        "thana": "কোতোয়ালী"
      },
      "গুরীবাজার": {
        "rates": {
          "বাড়ী": {"rate": 1663475},
          "ভিটা": {"rate": 1663475},
          "পুকুর": {"rate": 803361}
        },
        "jl": "17",
        "thana": "কোতোয়ালী"
      },
      "সুজাকাটগড়": {
        "rates": {
          "বাড়ী": {"rate": 2812275},
          "ভিটা": {"rate": 2812275},
          "পুকুর": {"rate": 1855726}
        },
        "jl": "16",
        "thana": "কোতোয়ালী"
      },
      "বটতলী": {
        "rates": {
          "বাড়ী": {"rate": 2596898},
          "ভিটা": {"rate": 2596898},
          "পুকুর": {"rate": 880000, "p": true}
        },
        "jl": "10",
        "thana": "কোতোয়ালী"
      },
      "এনায়েত বাজার": {
        "rates": {
          "বাড়ী": {"rate": 2346905},
          "ভিটা": {"rate": 2346905},
          "পুকুর": {"rate": 645257, "p": true}
        },
        "jl": "09",
        "thana": "কোতোয়ালী"
      },
      "মনোহরখালী": {
        "rates": {
          "বাড়ী": {"rate": 2034866},
          "ভিটা": {"rate": 2034866},
          "পুকুর": {"rate": 661429, "p": true}
        },
        "jl": "19",
        "thana": "কোতোয়ালী"
      },
      "আলমশাহ কাটগড়": {
        "rates": {
          "বাড়ী": {"rate": 2304387},
          "ভিটা": {"rate": 2304387},
          "পুকুর": {"rate": 650000, "p": true}
        },
        "jl": "5",
        "thana": "কোতোয়ালী"
      },
      "ইমামগঞ্জ": {
        "rates": {
          "বাড়ী": {"rate": 3700952},
          "ভিটা": {"rate": 3700952},
          "পুকুর": {"rate": 310000, "p": true}
        },
        "jl": "3",
        "thana": "কোতোয়ালী"
      },
      "উঃ পাহাড়তলী ঝুলনী": {
        "rates": {
          "নাল": {"rate": 136830, "p": true},
          "বাড়ী": {"rate": 3017563},
          "ভিটা": {"rate": 3017563},
          "পুকুর": {"rate": 1000000, "p": true}
        },
        "jl": "1",
        "thana": "কোতোয়ালী"
      },
      "জয় পাহাড়": {
        "rates": {
          "বাড়ী": {"rate": 2834518},
          "ভিটা": {"rate": 2834518},
          "পুকুর": {"rate": 1100000, "p": true}
        },
        "jl": "6",
        "thana": "কোতোয়ালী"
      },
      "দঃ পাহাড়তলী ঝুলনী": {
        "rates": {
          "নাল": {"rate": 250000, "p": true},
          "বাড়ী": {"rate": 2726797},
          "ভিটা": {"rate": 2726797},
          "পুকুর": {"rate": 1000000, "p": true}
        },
        "jl": "7",
        "thana": "কোতোয়ালী"
      },
      "ক্রমঘাটা": {
        "rates": {
          "নাল": {"rate": 450000, "p": true},
          "বাড়ী": {"rate": 2381450},
          "ভিটা": {"rate": 2381450},
          "পুকুর": {"rate": 757575, "p": true}
        },
        "jl": "14",
        "thana": "কোতোয়ালী"
      },
      "কর্ণটি": {
        "rates": {
          "বাড়ী": {"rate": 1547005},
          "ভিটা": {"rate": 1547005},
          "পুকুর": {"rate": 280684, "p": true}
        },
        "jl": "18",
        "thana": "কোতোয়ালী"
      },
      "লালখান বাজার": {
        "variants": [
          {
            "rates": {
              "বাড়ী": {"rate": 2126858},
              "ভিটা": {"rate": 2126858},
              "পুকুর": {"rate": 634147, "p": true}
            },
            "jl": "8",
            "thana": "কোতোয়ালী"
          },
          {
            "rates": {
              "নাল": {"rate": 232000, "p": true},
              "বাড়ী": {"rate": 2916192},
              "ভিটা": {"rate": 2916192},
              "পুকুর": {"rate": 710000, "p": true}
            },
            "jl": "08",
            "thana": "খুলশী"
          },
          {
            "rates": {
              "নাল": {"rate": 232000, "p": true},
              "বাড়ী": {"rate": 2061045, "p": true},
              "ভিটা": {"rate": 2061045, "p": true},
              "পুকুর": {"rate": 555554, "p": true}
            },
            "jl": "08",
            "thana": "ডবলমুরিং"
          }
        ]
      },
      "পাঁচলাইশ": {
        "rates": {
          "নাল": {"rate": 624973},
          "বাড়ী": {"rate": 1238435},
          "ভিটা": {"rate": 1238435},
          "পুকুর": {"rate": 515286}
        },
        "jl": "07",
        "thana": "পাঁচলাইশ"
      },
      "পূর্ব নাছিরাবাদ": {
        "variants": [
          {
            "rates": {
              "নাল": {"rate": 769379},
              "বাড়ী": {"rate": 24142767},
              "ভিটা": {"rate": 24142767},
              "পুকুর": {"rate": 704037}
            },
            "jl": "03",
            "thana": "পাঁচলাইশ"
          },
          {
            "rates": {
              "নাল": {"rate": 322026, "p": true},
              "বাড়ী": {"rate": 1561856},
              "ভিটা": {"rate": 1561856},
              "পুকুর": {"rate": 600000, "p": true}
            },
            "jl": "03",
            "thana": "খুলশী"
          }
        ]
      },
      "পূর্ব নাছিরাবাদ (শিল্প)": {
        "rates": {
          "বাড়ী": {"rate": 2186442},
          "ভিটা": {"rate": 2186442}
        },
        "jl": "03",
        "thana": "পাঁচলাইশ"
      },
      "জালালাবাদ": {
        "rates": {
          "নাল": {"rate": 663702},
          "বাড়ী": {"rate": 2348396},
          "ভিটা": {"rate": 2348396},
          "পুকুর": {"rate": 422039, "p": true}
        },
        "jl": "01",
        "thana": "পাঁচলাইশ"
      },
      "কুলগাঁও": {
        "rates": {
          "নাল": {"rate": 609115},
          "বাড়ী": {"rate": 1092796},
          "ভিটা": {"rate": 1092796},
          "পুকুর": {"rate": 714076}
        },
        "jl": "02",
        "thana": "পাঁচলাইশ"
      },
      "পশ্চিম ষোলশহর": {
        "rates": {
          "নাল": {"rate": 713255},
          "বাড়ী": {"rate": 2212484},
          "ভিটা": {"rate": 2212484},
          "পুকুর": {"rate": 710362}
        },
        "jl": "08",
        "thana": "পাঁচলাইশ"
      },
      "মুরাদপুর": {
        "rates": {
          "নাল": {"rate": 304867},
          "বাড়ী": {"rate": 3831756},
          "ভিটা": {"rate": 3831756},
          "পুকুর": {"rate": 975277, "p": true}
        },
        "jl": "04",
        "thana": "পাঁচলাইশ"
      },
      "শুলকবহর": {
        "rates": {
          "নাল": {"rate": 1585480},
          "বাড়ী": {"rate": 1819271},
          "ভিটা": {"rate": 1819271},
          "পুকুর": {"rate": 904328}
        },
        "jl": "05",
        "thana": "পাঁচলাইশ"
      },
      "পূর্ব পাহাড়তলী": {
        "rates": {
          "নাল": {"rate": 273061},
          "বাড়ী": {"rate": 1226038},
          "ভিটা": {"rate": 1226038},
          "পুকুর": {"rate": 400000, "p": true}
        },
        "jl": "01",
        "thana": "পাঁচলাইশ"
      },
      "ঝুলনী": {
        "rates": {
          "নাল": {"rate": 626769},
          "বাড়ী": {"rate": 2308114},
          "ভিটা": {"rate": 2308114},
          "পুকুর": {"rate": 833333}
        },
        "jl": "02",
        "thana": "পাঁচলাইশ"
      },
      "দঃ পাহাড়তলী": {
        "variants": [
          {
            "rates": {
              "নাল": {"rate": 500510, "p": true},
              "বাড়ী": {"rate": 11275948},
              "ভিটা": {"rate": 11275948},
              "পুকুর": {"rate": 597750}
            },
            "jl": "06",
            "thana": "খুলশী"
          },
          {
            "rates": {
              "নাল": {"rate": 849292},
              "বাড়ী": {"rate": 2146356},
              "ভিটা": {"rate": 2146356},
              "পুকুর": {"rate": 680086}
            },
            "jl": "06",
            "thana": "ডবলমুরিং"
          }
        ]
      },
      "মাদারবাড়ী": {
        "variants": [
          {
            "rates": {
              "বাড়ী": {"rate": 1904257},
              "ভিটা": {"rate": 1904257},
              "পুকুর": {"rate": 1146555}
            },
            "jl": "16",
            "thana": "ডবলমুরিং"
          },
          {
            "rates": {
              "বাড়ী": {"rate": 1749590},
              "ভিটা": {"rate": 1749590},
              "পুকুর": {"rate": 467208, "p": true}
            },
            "jl": "04",
            "thana": "বন্দর"
          }
        ]
      },
      "মোগলটুলী": {
        "rates": {
          "নাল": {"rate": 699300, "p": true},
          "বাড়ী": {"rate": 2281899},
          "ভিটা": {"rate": 2281899},
          "পুকুর": {"rate": 1025205}
        },
        "jl": "14",
        "thana": "ডবলমুরিং"
      },
      "পাঠানটুলী": {
        "rates": {
          "নাল": {"rate": 700000, "p": true},
          "বাড়ী": {"rate": 1797478},
          "ভিটা": {"rate": 1797478},
          "পুকুর": {"rate": 650193}
        },
        "jl": "13",
        "thana": "ডবলমুরিং"
      },
      "গোসাইলডাঙ্গা": {
        "rates": {
          "নাল": {"rate": 666666},
          "বাড়ী": {"rate": 6861504},
          "ভিটা": {"rate": 6861504},
          "পুকুর": {"rate": 1056815}
        },
        "jl": "17",
        "thana": "ডবলমুরিং"
      },
      "আগ্রাবাদ": {
        "rates": {
          "নাল": {"rate": 977797},
          "বাড়ী": {"rate": 1765374},
          "ভিটা": {"rate": 1765374},
          "পুকুর": {"rate": 870712}
        },
        "jl": "11",
        "thana": "ডবলমুরিং"
      },
      "আস্কারাবাদ": {
        "rates": {
          "নাল": {"rate": 500000, "p": true},
          "বাড়ী": {"rate": 1850786},
          "ভিটা": {"rate": 1850786},
          "পুকুর": {"rate": 660000}
        },
        "jl": "12",
        "thana": "ডবলমুরিং"
      },
      "মগবাজার": {
        "rates": {
          "নাল": {"rate": 160000, "p": true},
          "বাড়ী": {"rate": 2159485},
          "ভিটা": {"rate": 2159485},
          "পুকুর": {"rate": 400000, "p": true}
        },
        "jl": "15",
        "thana": "ডবলমুরিং"
      },
      "দক্ষিণ পতেঙ্গা": {
        "rates": {
          "নাল": {"rate": 413365},
          "বাড়ী": {"rate": 647972},
          "ভিটা": {"rate": 647972},
          "পুকুর": {"rate": 243963}
        },
        "jl": "25",
        "thana": "বন্দর"
      },
      "উত্তর পতেঙ্গা": {
        "rates": {
          "নাল": {"rate": 401106},
          "বাড়ী": {"rate": 908769},
          "ভিটা": {"rate": 908769},
          "পুকুর": {"rate": 428643}
        },
        "jl": "24",
        "thana": "বন্দর"
      },
      "পূর্ব পতেঙ্গা": {
        "rates": {
          "নাল": {"rate": 379807},
          "বাড়ী": {"rate": 631013},
          "ভিটা": {"rate": 631013},
          "পুকুর": {"rate": 299065}
        },
        "jl": "26",
        "thana": "বন্দর"
      },
      "দক্ষিণ হালিশহর": {
        "rates": {
          "নাল": {"rate": 549605},
          "বাড়ী": {"rate": 1335271},
          "ভিটা": {"rate": 1335271},
          "পুকুর": {"rate": 565968}
        },
        "jl": "23",
        "thana": "বন্দর"
      },
      "মধ্য হালিশহর": {
        "rates": {
          "নাল": {"rate": 498545},
          "বাড়ী": {"rate": 986838},
          "ভিটা": {"rate": 986838},
          "পুকুর": {"rate": 519859}
        },
        "jl": "01",
        "thana": "বন্দর"
      },
      "বন্দর": {
        "rates": {
          "নাল": {"rate": 216531},
          "বাড়ী": {"rate": 395459},
          "ভিটা": {"rate": 395459},
          "বাগান": {"rate": 256490, "p": true},
          "পুকুর": {"rate": 407751}
        },
        "jl": "30",
        "thana": "বন্দর"
      },
      "জুলধা": {
        "rates": {
          "নাল": {"rate": 500000},
          "বাড়ী": {"rate": 201225, "p": true},
          "ভিটা": {"rate": 201225, "p": true},
          "পুকুর": {"rate": 51666, "p": true}
        },
        "jl": "27",
        "thana": "বন্দর"
      },
      "ইছানগর": {
        "rates": {
          "নাল": {"rate": 250000},
          "বাড়ী": {"rate": 464097},
          "ভিটা": {"rate": 464097},
          "পুকুর": {"rate": 88800, "p": true}
        },
        "jl": "20",
        "thana": "বন্দর"
      },
      "ডাঙ্গারচর": {
        "rates": {
          "নাল": {"rate": 250000},
          "বাড়ী": {"rate": 246779, "p": true},
          "ভিটা": {"rate": 246779, "p": true},
          "পুকুর": {"rate": 112525, "p": true}
        },
        "jl": "27",
        "thana": "বন্দর"
      },
      "চরলক্ষ্যা": {
        "rates": {
          "নাল": {"rate": 159552, "p": true},
          "বাড়ী": {"rate": 122140, "p": true},
          "ভিটা": {"rate": 122140, "p": true},
          "পুকুর": {"rate": 33955, "p": true}
        },
        "jl": "21",
        "thana": "বন্দর"
      },
      "দ্বীপকালামোড়ল": {
        "rates": {
          "নাল": {"rate": 1025000, "p": true},
          "বাড়ী": {"rate": 441878, "p": true},
          "ভিটা": {"rate": 441878, "p": true},
          "পুকুর": {"rate": 176470, "p": true}
        },
        "jl": "17",
        "thana": "বন্দর"
      },
      "চরফরিদ": {
        "rates": {
          "নাল": {"rate": 86645, "p": true},
          "বাড়ী": {"rate": 109490, "p": true},
          "ভিটা": {"rate": 109490, "p": true},
          "পুকুর": {"rate": 30000, "p": true}
        },
        "jl": "09",
        "thana": "বন্দর"
      },
      "ঘোড়াজনগর": {
        "rates": {
          "নাল": {"rate": 55000, "p": true},
          "বাড়ী": {"rate": 60715, "p": true},
          "ভিটা": {"rate": 60715, "p": true},
          "পুকুর": {"rate": 13000, "p": true}
        },
        "jl": "11",
        "thana": "বন্দর"
      },
      "শাহমীরপুর": {
        "rates": {
          "নাল": {"rate": 212909},
          "বাড়ী": {"rate": 335347, "p": true},
          "ভিটা": {"rate": 335347, "p": true},
          "পুকুর": {"rate": 81091, "p": true}
        },
        "jl": "28",
        "thana": "বন্দর"
      },
      "চরপাথরঘাটা": {
        "rates": {
          "নাল": {"rate": 514652, "p": true},
          "বাড়ী": {"rate": 638226},
          "ভিটা": {"rate": 638226},
          "পুকুর": {"rate": 486352, "p": true}
        },
        "jl": "19",
        "thana": "বন্দর"
      },
      "শিকলবাহা (বরফ ১২০০ ফুট পর্যন্ত)": {
        "rates": {
          "নাল": {"rate": 400000},
          "বাড়ী": {"rate": 443483, "p": true},
          "ভিটা": {"rate": 443483, "p": true},
          "বাগান": {"rate": 30000, "p": true},
          "পুকুর": {"rate": 243017, "p": true}
        },
        "jl": "18",
        "thana": "বন্দর"
      },
      "শিকলবাহা (বরফ ৫০০ দাগের উপরে)": {
        "rates": {
          "নাল": {"rate": 68000, "p": true},
          "বাড়ী": {"rate": 80000, "p": true},
          "ভিটা": {"rate": 80000, "p": true},
          "পুকুর": {"rate": 108000, "p": true}
        },
        "jl": "18",
        "thana": "বন্দর"
      },
      "কোলাগাঁও": {
        "rates": {
          "নাল": {"rate": 100000},
          "বাড়ী": {"rate": 70900, "p": true},
          "ভিটা": {"rate": 70900, "p": true},
          "পুকুর": {"rate": 73312, "p": true}
        },
        "jl": "01",
        "thana": "বন্দর"
      }
    }
  },
  'mirsharai-jorarganj': {
    "name": "মীরসরাই ও জোরারগঞ্জ",
    "period": "2025-2026",
    "mouzas": {
      "জয়পুর পূর্ব জোয়ারার": {
        "rates": {
          "নাল": {"rate": 32966},
          "বাড়ী": {"rate": 106009},
          "ভিটা": {"rate": 106009},
          "বাগান": {"rate": 26771},
          "পুকুর": {"rate": 23377},
          "ডোবা": {"rate": 23377}
        },
        "jl": "01"
      },
      "পশ্চিম জোয়ারার": {
        "rates": {
          "নাল": {"rate": 33307},
          "বাড়ী": {"rate": 92219},
          "ভিটা": {"rate": 92219},
          "পুকুর": {"rate": 73010},
          "ডোবা": {"rate": 73010}
        },
        "jl": "02"
      },
      "কাটগাং": {
        "rates": {
          "নাল": {"rate": 36105},
          "বাড়ী": {"rate": 82138},
          "ভিটা": {"rate": 82138},
          "বাগান": {"rate": 8000},
          "পুকুর": {"rate": 53800},
          "ডোবা": {"rate": 53800}
        },
        "jl": "03"
      },
      "ভালুকিয়া": {
        "rates": {
          "নাল": {"rate": 52578},
          "বাড়ী": {"rate": 135868},
          "ভিটা": {"rate": 135868},
          "পুকুর": {"rate": 69820},
          "ডোবা": {"rate": 69820}
        },
        "jl": "04"
      },
      "বৈরিয়া": {
        "rates": {
          "নাল": {"rate": 54982},
          "বাড়ী": {"rate": 126000},
          "ভিটা": {"rate": 126000},
          "পুকুর": {"rate": 52292},
          "ডোবা": {"rate": 52292}
        },
        "jl": "05"
      },
      "পশ্চিম অলি নগর": {
        "rates": {
          "নাল": {"rate": 75945},
          "বাড়ী": {"rate": 61167},
          "ভিটা": {"rate": 61167},
          "বাগান": {"rate": 45455},
          "পুকুর": {"rate": 41638},
          "ডোবা": {"rate": 41638}
        },
        "jl": "06"
      },
      "পূর্ব অলি নগর": {
        "rates": {
          "নাল": {"rate": 17556},
          "বাড়ী": {"rate": 9490},
          "ভিটা": {"rate": 9490},
          "পুকুর": {"rate": 6980},
          "ডোবা": {"rate": 6980}
        },
        "jl": "07"
      },
      "ঘেড়ামারা": {
        "rates": {
          "নাল": {"rate": 17822},
          "বাড়ী": {"rate": 58853},
          "ভিটা": {"rate": 58853},
          "বাগান": {"rate": 12190},
          "পুকুর": {"rate": 16000},
          "ডোবা": {"rate": 16000}
        },
        "jl": "08"
      },
      "ছছরুয়া": {
        "rates": {
          "নাল": {"rate": 73172},
          "বাড়ী": {"rate": 183382},
          "ভিটা": {"rate": 183382},
          "পুকুর": {"rate": 343909},
          "ডোবা": {"rate": 343909}
        },
        "jl": "09"
      },
      "দক্ষিণ অলি নগর": {
        "rates": {
          "নাল": {"rate": 28577},
          "বাড়ী": {"rate": 40321},
          "ভিটা": {"rate": 40321},
          "পুকুর": {"rate": 21150},
          "ডোবা": {"rate": 21150}
        },
        "jl": "10"
      },
      "পূর্ব হিঙ্গুলী": {
        "rates": {
          "নাল": {"rate": 80166},
          "বাড়ী": {"rate": 160607},
          "ভিটা": {"rate": 160607},
          "বাগান": {"rate": 81667},
          "পুকুর": {"rate": 25104},
          "ডোবা": {"rate": 25104}
        },
        "jl": "11"
      },
      "পূর্ব হিঙ্গুলী পৌর": {
        "rates": {
          "নাল": {"rate": 409824},
          "বাড়ী": {"rate": 288656},
          "ভিটা": {"rate": 288656},
          "পুকুর": {"rate": 81819},
          "ডোবা": {"rate": 81819}
        },
        "jl": "11"
      },
      "খিল মুরারী": {
        "rates": {
          "নাল": {"rate": 285830},
          "বাড়ী": {"rate": 284412},
          "ভিটা": {"rate": 284412},
          "বাগান": {"rate": 30151},
          "পুকুর": {"rate": 66667},
          "ডোবা": {"rate": 66667}
        },
        "jl": "12"
      },
      "সোনা পাহাড়": {
        "rates": {
          "নাল": {"rate": 150599},
          "বাড়ী": {"rate": 350278},
          "ভিটা": {"rate": 350278},
          "বাগান": {"rate": 307901},
          "পুকুর": {"rate": 368204},
          "ডোবা": {"rate": 368204}
        },
        "jl": "13"
      },
      "সোনা পাহাড় পৌর": {
        "rates": {
          "নাল": {"rate": 374930},
          "বাড়ী": {"rate": 404784},
          "ভিটা": {"rate": 404784},
          "বাগান": {"rate": 604000},
          "পুকুর": {"rate": 906993},
          "ডোবা": {"rate": 906993}
        },
        "jl": "13"
      },
      "হাজীষ্মরাই": {
        "rates": {
          "নাল": {"rate": 80649},
          "বাড়ী": {"rate": 110077},
          "ভিটা": {"rate": 110077},
          "বাগান": {"rate": 37838},
          "পুকুর": {"rate": 84453},
          "ডোবা": {"rate": 84453}
        },
        "jl": "14"
      },
      "গোপীনাথ পুর": {
        "rates": {
          "নাল": {"rate": 37333},
          "বাড়ী": {"rate": 185724},
          "ভিটা": {"rate": 185724},
          "পুকুর": {"rate": 132928},
          "ডোবা": {"rate": 132928}
        },
        "jl": "15"
      },
      "নন্দন পুর": {
        "rates": {
          "নাল": {"rate": 64886},
          "বাড়ী": {"rate": 277214},
          "ভিটা": {"rate": 277214},
          "পুকুর": {"rate": 66070},
          "ডোবা": {"rate": 66070}
        },
        "jl": "16"
      },
      "দেওয়ান পুর": {
        "rates": {
          "নাল": {"rate": 213569},
          "বাড়ী": {"rate": 298230},
          "ভিটা": {"rate": 298230},
          "পুকুর": {"rate": 213369},
          "ডোবা": {"rate": 213369}
        },
        "jl": "17"
      },
      "পরাগল পুর": {
        "rates": {
          "নাল": {"rate": 100398},
          "বাড়ী": {"rate": 71256},
          "ভিটা": {"rate": 71256},
          "পুকুর": {"rate": 121705},
          "ডোবা": {"rate": 121705}
        },
        "jl": "18"
      },
      "ইমাম পুর": {
        "rates": {
          "নাল": {"rate": 91045},
          "বাড়ী": {"rate": 78764},
          "ভিটা": {"rate": 78764},
          "বাগান": {"rate": 30000},
          "পুকুর": {"rate": 71096},
          "ডোবা": {"rate": 71096}
        },
        "jl": "19"
      },
      "ইমাম পুর পৌর": {
        "rates": {
          "নাল": {"rate": 53708},
          "বাড়ী": {"rate": 56512},
          "ভিটা": {"rate": 56512},
          "বাগান": {"rate": 138889},
          "পুকুর": {"rate": 45965},
          "ডোবা": {"rate": 45965}
        },
        "jl": "19"
      },
      "জামাল পুর": {
        "rates": {
          "নাল": {"rate": 137853},
          "বাড়ী": {"rate": 238686},
          "ভিটা": {"rate": 238686},
          "বাগান": {"rate": 37500},
          "পুকুর": {"rate": 139604},
          "ডোবা": {"rate": 139604}
        },
        "jl": "20"
      },
      "জামাল পুর পৌর": {
        "rates": {
          "নাল": {"rate": 318475},
          "বাড়ী": {"rate": 671989},
          "ভিটা": {"rate": 671989},
          "পুকুর": {"rate": 164698},
          "ডোবা": {"rate": 164698}
        },
        "jl": "20"
      },
      "আজম নগর": {
        "rates": {
          "নাল": {"rate": 150341},
          "বাড়ী": {"rate": 232651},
          "ভিটা": {"rate": 232651},
          "বাগান": {"rate": 98524},
          "পুকুর": {"rate": 321075},
          "ডোবা": {"rate": 321075}
        },
        "jl": "21"
      },
      "আজম নগর পৌর": {
        "rates": {
          "নাল": {"rate": 519051},
          "বাড়ী": {"rate": 434001},
          "ভিটা": {"rate": 434001},
          "পুকুর": {"rate": 603731},
          "ডোবা": {"rate": 603731}
        },
        "jl": "21"
      },
      "পশ্চিম হিঙ্গুলী": {
        "rates": {
          "নাল": {"rate": 87069},
          "বাড়ী": {"rate": 142571},
          "ভিটা": {"rate": 142571},
          "বাগান": {"rate": 109485},
          "পুকুর": {"rate": 67103},
          "ডোবা": {"rate": 67103}
        },
        "jl": "22"
      },
      "পশ্চিম হিঙ্গুলী পৌর": {
        "rates": {
          "নাল": {"rate": 471212},
          "বাড়ী": {"rate": 150000},
          "ভিটা": {"rate": 150000}
        },
        "jl": "22"
      },
      "ধুম": {
        "rates": {
          "নাল": {"rate": 75358},
          "বাড়ী": {"rate": 95210},
          "ভিটা": {"rate": 95210},
          "বাগান": {"rate": 33712},
          "পুকুর": {"rate": 62848},
          "ডোবা": {"rate": 62848}
        },
        "jl": "23"
      },
      "ধুম পৌর": {
        "rates": {
          "নাল": {"rate": 133333},
          "বাড়ী": {"rate": 91667},
          "ভিটা": {"rate": 91667},
          "পুকুর": {"rate": 95912},
          "ডোবা": {"rate": 95912}
        },
        "jl": "23"
      },
      "নাহের পুর": {
        "rates": {
          "নাল": {"rate": 30582},
          "বাড়ী": {"rate": 73537},
          "ভিটা": {"rate": 73537},
          "বাগান": {"rate": 17778},
          "পুকুর": {"rate": 29053},
          "ডোবা": {"rate": 29053}
        },
        "jl": "24"
      },
      "পূর্ব ভাজপুর": {
        "rates": {
          "নাল": {"rate": 30108},
          "বাড়ী": {"rate": 40428},
          "ভিটা": {"rate": 40428},
          "বাগান": {"rate": 28916},
          "পুকুর": {"rate": 49934},
          "ডোবা": {"rate": 49934}
        },
        "jl": "25"
      },
      "ভগবতী পুর": {
        "rates": {
          "নাল": {"rate": 41698},
          "বাড়ী": {"rate": 56250},
          "ভিটা": {"rate": 56250},
          "পুকুর": {"rate": 35597},
          "ডোবা": {"rate": 35597}
        },
        "jl": "26"
      },
      "পূর্ব গোবিন্দ পুর": {
        "rates": {
          "নাল": {"rate": 27118},
          "বাড়ী": {"rate": 30553},
          "ভিটা": {"rate": 30553},
          "বাগান": {"rate": 20500},
          "পুকুর": {"rate": 25942},
          "ডোবা": {"rate": 25942}
        },
        "jl": "27"
      },
      "সাহেব পুর": {
        "rates": {
          "নাল": {"rate": 40140},
          "বাড়ী": {"rate": 18351},
          "ভিটা": {"rate": 18351},
          "বাগান": {"rate": 14667},
          "পুকুর": {"rate": 47212},
          "ডোবা": {"rate": 47212}
        },
        "jl": "28"
      },
      "পাতাকোট": {
        "rates": {
          "নাল": {"rate": 49211},
          "বাড়ী": {"rate": 114937},
          "ভিটা": {"rate": 114937},
          "বাগান": {"rate": 12500},
          "পুকুর": {"rate": 39301},
          "ডোবা": {"rate": 39301}
        },
        "jl": "29"
      },
      "ভগমান পুর": {
        "rates": {
          "নাল": {"rate": 41070},
          "বাড়ী": {"rate": 144909},
          "ভিটা": {"rate": 144909},
          "পুকুর": {"rate": 73778},
          "ডোবা": {"rate": 73778}
        },
        "jl": "30"
      },
      "রোকন্দি পুর": {
        "rates": {
          "নাল": {"rate": 40496},
          "বাড়ী": {"rate": 12350},
          "ভিটা": {"rate": 12350},
          "বাগান": {"rate": 15517},
          "পুকুর": {"rate": 10199},
          "ডোবা": {"rate": 10199}
        },
        "jl": "31"
      },
      "মরগাং": {
        "rates": {
          "নাল": {"rate": 24352},
          "বাড়ী": {"rate": 59014},
          "ভিটা": {"rate": 59014},
          "বাগান": {"rate": 10500},
          "পুকুর": {"rate": 24863},
          "ডোবা": {"rate": 24863}
        },
        "jl": "32"
      },
      "বৃন্দাবন পুর": {
        "rates": {
          "নাল": {"rate": 19534},
          "বাড়ী": {"rate": 23166},
          "ভিটা": {"rate": 23166},
          "পুকুর": {"rate": 8089},
          "ডোবা": {"rate": 8089}
        },
        "jl": "33"
      },
      "মোবারক ঘোনা": {
        "rates": {
          "নাল": {"rate": 53800},
          "বাড়ী": {"rate": 101326},
          "ভিটা": {"rate": 101326},
          "পুকুর": {"rate": 49317},
          "ডোবা": {"rate": 49317}
        },
        "jl": "34"
      },
      "ফতেহ পুর": {
        "rates": {
          "নাল": {"rate": 1523},
          "বাড়ী": {"rate": 1819},
          "ভিটা": {"rate": 1819},
          "পুকুর": {"rate": 1000},
          "ডোবা": {"rate": 1000}
        },
        "jl": "35"
      },
      "আজম পুর": {
        "rates": {
          "নাল": {"rate": 29586},
          "বাড়ী": {"rate": 7789},
          "ভিটা": {"rate": 7789},
          "পুকুর": {"rate": 5500},
          "ডোবা": {"rate": 5500}
        },
        "jl": "36"
      },
      "পশ্চিম ভাজপুর": {
        "rates": {
          "নাল": {"rate": 3000},
          "বাড়ী": {"rate": 982},
          "ভিটা": {"rate": 982},
          "পুকুর": {"rate": 728},
          "ডোবা": {"rate": 728}
        },
        "jl": "38"
      },
      "বাঁশখালী": {
        "rates": {
          "নাল": {"rate": 58656},
          "বাড়ী": {"rate": 84526},
          "ভিটা": {"rate": 84526},
          "পুকুর": {"rate": 51457},
          "ডোবা": {"rate": 51457}
        },
        "jl": "39"
      },
      "কোস্পানী নগর": {
        "rates": {
          "নাল": {"rate": 1400},
          "বাড়ী": {"rate": 465},
          "ভিটা": {"rate": 465},
          "পুকুর": {"rate": 390},
          "ডোবা": {"rate": 390}
        },
        "jl": "40"
      },
      "উত্তর ইছাখালী": {
        "rates": {
          "নাল": {"rate": 44273},
          "বাড়ী": {"rate": 86481},
          "ভিটা": {"rate": 86481},
          "বাগান": {"rate": 23991},
          "পুকুর": {"rate": 72682},
          "ডোবা": {"rate": 72682}
        },
        "jl": "41"
      },
      "ইদিল পুর": {
        "rates": {
          "নাল": {"rate": 12320},
          "বাড়ী": {"rate": 18225},
          "ভিটা": {"rate": 18225},
          "বাগান": {"rate": 20000},
          "পুকুর": {"rate": 172115},
          "ডোবা": {"rate": 172115}
        },
        "jl": "42"
      },
      "তেমুহানী মুরাদপুর": {
        "rates": {
          "নাল": {"rate": 36698},
          "বাড়ী": {"rate": 42134},
          "ভিটা": {"rate": 42134},
          "বাগান": {"rate": 13462},
          "পুকুর": {"rate": 31911},
          "ডোবা": {"rate": 31911}
        },
        "jl": "43"
      },
      "কাঁটাছড়া": {
        "rates": {
          "নাল": {"rate": 36462},
          "বাড়ী": {"rate": 48899},
          "ভিটা": {"rate": 48899},
          "বাগান": {"rate": 37159},
          "পুকুর": {"rate": 43032},
          "ডোবা": {"rate": 43032}
        },
        "jl": "44"
      },
      "জনার্দন পুর": {
        "rates": {
          "নাল": {"rate": 22759},
          "বাড়ী": {"rate": 19685},
          "ভিটা": {"rate": 19685},
          "পুকুর": {"rate": 31049},
          "ডোবা": {"rate": 31049}
        },
        "jl": "45"
      },
      "শিকার জনার্দন পুর": {
        "rates": {
          "নাল": {"rate": 46195},
          "বাড়ী": {"rate": 67059},
          "ভিটা": {"rate": 67059},
          "পুকুর": {"rate": 38417},
          "ডোবা": {"rate": 38417}
        },
        "jl": "46"
      },
      "গোপাল পুর": {
        "rates": {
          "নাল": {"rate": 62087},
          "বাড়ী": {"rate": 83333},
          "ভিটা": {"rate": 83333},
          "পুকুর": {"rate": 69231},
          "ডোবা": {"rate": 69231}
        },
        "jl": "47"
      },
      "হরিহর পুর": {
        "rates": {
          "নাল": {"rate": 29807},
          "বাড়ী": {"rate": 85197},
          "ভিটা": {"rate": 85197},
          "পুকুর": {"rate": 21309},
          "ডোবা": {"rate": 21309}
        },
        "jl": "48"
      },
      "রায়পুর": {
        "rates": {
          "নাল": {"rate": 72917},
          "বাড়ী": {"rate": 113433},
          "ভিটা": {"rate": 113433},
          "পুকুর": {"rate": 31485},
          "ডোবা": {"rate": 31485}
        },
        "jl": "49"
      },
      "রঘুনাথ পুর": {
        "rates": {
          "নাল": {"rate": 140748},
          "বাড়ী": {"rate": 115568},
          "ভিটা": {"rate": 115568},
          "পুকুর": {"rate": 83019},
          "ডোবা": {"rate": 83019}
        },
        "jl": "50"
      },
      "পূর্ব মিঠানালা": {
        "rates": {
          "নাল": {"rate": 93939},
          "বাড়ী": {"rate": 277907},
          "ভিটা": {"rate": 277907},
          "বাগান": {"rate": 83360},
          "পুকুর": {"rate": 107225},
          "ডোবা": {"rate": 107225}
        },
        "jl": "51"
      },
      "পূর্ব মিঠানালা পৌর": {
        "rates": {
          "নাল": {"rate": 375417},
          "বাড়ী": {"rate": 28572},
          "ভিটা": {"rate": 28572},
          "পুকুর": {"rate": 5300},
          "ডোবা": {"rate": 5300}
        },
        "jl": "51"
      },
      "দুর্গাপুর": {
        "rates": {
          "নাল": {"rate": 53777},
          "বাড়ী": {"rate": 127166},
          "ভিটা": {"rate": 127166},
          "বাগান": {"rate": 41176},
          "পুকুর": {"rate": 121573},
          "ডোবা": {"rate": 121573}
        },
        "jl": "52"
      },
      "মোটবাড়ীয়া": {
        "rates": {
          "নাল": {"rate": 253054},
          "বাড়ী": {"rate": 116274},
          "ভিটা": {"rate": 116274},
          "বাগান": {"rate": 20098},
          "পুকুর": {"rate": 185517},
          "ডোবা": {"rate": 185517}
        },
        "jl": "53"
      },
      "মিঠাছড়া": {
        "rates": {
          "নাল": {"rate": 75141},
          "বাড়ী": {"rate": 63905},
          "ভিটা": {"rate": 63905},
          "বাগান": {"rate": 8000},
          "পুকুর": {"rate": 122660},
          "ডোবা": {"rate": 122660}
        },
        "jl": "54"
      },
      "রাঘব পুর": {
        "rates": {
          "নাল": {"rate": 35593},
          "বাড়ী": {"rate": 78534},
          "ভিটা": {"rate": 78534},
          "পুকুর": {"rate": 107788},
          "ডোবা": {"rate": 107788}
        },
        "jl": "55"
      },
      "রাঘব পুর পৌর": {
        "rates": {
          "নাল": {"rate": 82211},
          "বাড়ী": {"rate": 92343},
          "ভিটা": {"rate": 92343},
          "বাগান": {"rate": 88888},
          "পুকুর": {"rate": 89008},
          "ডোবা": {"rate": 89008}
        },
        "jl": "55"
      },
      "মহাছিম পুর": {
        "rates": {
          "নাল": {"rate": 10000},
          "বাড়ী": {"rate": 14000},
          "ভিটা": {"rate": 14000},
          "পুকুর": {"rate": 10700},
          "ডোবা": {"rate": 10700}
        },
        "jl": "56"
      },
      "মহাছিম পুর পৌর": {
        "rates": {
          "নাল": {"rate": 30517},
          "বাড়ী": {"rate": 46000},
          "ভিটা": {"rate": 46000},
          "পুকুর": {"rate": 33333},
          "ডোবা": {"rate": 33333}
        },
        "jl": "56"
      },
      "কছুয়া": {
        "rates": {
          "নাল": {"rate": 34304},
          "বাড়ী": {"rate": 24066},
          "ভিটা": {"rate": 24066},
          "বাগান": {"rate": 14000},
          "পুকুর": {"rate": 38838},
          "ডোবা": {"rate": 38838}
        },
        "jl": "57"
      },
      "পূর্ব মলিয়াইশ": {
        "rates": {
          "নাল": {"rate": 36054},
          "বাড়ী": {"rate": 36190},
          "ভিটা": {"rate": 36190},
          "পুকুর": {"rate": 52115},
          "ডোবা": {"rate": 52115}
        },
        "jl": "58"
      },
      "সৈয়দপুর": {
        "rates": {
          "নাল": {"rate": 33298},
          "বাড়ী": {"rate": 35146},
          "ভিটা": {"rate": 35146},
          "পুকুর": {"rate": 40137},
          "ডোবা": {"rate": 40137}
        },
        "jl": "59"
      },
      "ঝিনান": {
        "rates": {
          "নাল": {"rate": 21376},
          "বাড়ী": {"rate": 20579},
          "ভিটা": {"rate": 20579},
          "বাগান": {"rate": 10895},
          "পুকুর": {"rate": 53710},
          "ডোবা": {"rate": 53710}
        },
        "jl": "60"
      },
      "মিঠানালা রাজাপুর": {
        "rates": {
          "নাল": {"rate": 46847},
          "বাড়ী": {"rate": 35273},
          "ভিটা": {"rate": 35273},
          "বাগান": {"rate": 38830},
          "পুকুর": {"rate": 39250},
          "ডোবা": {"rate": 39250}
        },
        "jl": "61"
      },
      "বামন সুন্দর": {
        "rates": {
          "নাল": {"rate": 64719},
          "বাড়ী": {"rate": 63655},
          "ভিটা": {"rate": 63655},
          "বাগান": {"rate": 13333},
          "পুকুর": {"rate": 51582},
          "ডোবা": {"rate": 51582}
        },
        "jl": "62"
      },
      "রহমতাবাদ": {
        "rates": {
          "নাল": {"rate": 28065},
          "বাড়ী": {"rate": 67357},
          "ভিটা": {"rate": 67357},
          "বাগান": {"rate": 28000},
          "পুকুর": {"rate": 42591},
          "ডোবা": {"rate": 42591}
        },
        "jl": "63"
      },
      "পশ্চিম মিঠানালা": {
        "rates": {
          "নাল": {"rate": 29399},
          "বাড়ী": {"rate": 24053},
          "ভিটা": {"rate": 24053},
          "বাগান": {"rate": 6000},
          "পুকুর": {"rate": 21581},
          "ডোবা": {"rate": 21581}
        },
        "jl": "64"
      },
      "বাড়ীয়াঝালী": {
        "rates": {
          "নাল": {"rate": 21298},
          "বাড়ী": {"rate": 25230},
          "ভিটা": {"rate": 25230},
          "বাগান": {"rate": 7975},
          "পুকুর": {"rate": 30957},
          "ডোবা": {"rate": 30957}
        },
        "jl": "65"
      },
      "পশ্চিম ইছাখালী": {
        "rates": {
          "নাল": {"rate": 44694},
          "বাড়ী": {"rate": 21422},
          "ভিটা": {"rate": 21422},
          "বাগান": {"rate": 6800},
          "পুকুর": {"rate": 43145},
          "ডোবা": {"rate": 43145}
        },
        "jl": "66"
      },
      "পূর্ব ইছাখালী": {
        "rates": {
          "নাল": {"rate": 36455},
          "বাড়ী": {"rate": 71614},
          "ভিটা": {"rate": 71614},
          "বাগান": {"rate": 4348},
          "পুকুর": {"rate": 125236},
          "ডোবা": {"rate": 125236}
        },
        "jl": "67"
      },
      "উত্তর মুরাদপুর": {
        "rates": {
          "নাল": {"rate": 40543},
          "বাড়ী": {"rate": 5100},
          "ভিটা": {"rate": 5100},
          "পুকুর": {"rate": 6223},
          "ডোবা": {"rate": 6223}
        },
        "jl": "68"
      },
      "মধ্য মুরাদপুর": {
        "rates": {
          "নাল": {"rate": 20488},
          "বাড়ী": {"rate": 20422},
          "ভিটা": {"rate": 20422},
          "বাগান": {"rate": 6621},
          "পুকুর": {"rate": 92463},
          "ডোবা": {"rate": 92463}
        },
        "jl": "69"
      },
      "পশ্চিম মলিয়াইশ": {
        "rates": {
          "নাল": {"rate": 26788},
          "বাড়ী": {"rate": 26680},
          "ভিটা": {"rate": 26680},
          "বাগান": {"rate": 7671},
          "পুকুর": {"rate": 20656},
          "ডোবা": {"rate": 20656}
        },
        "jl": "70"
      },
      "মধ্যম মঘাদিয়া": {
        "rates": {
          "নাল": {"rate": 74778},
          "বাড়ী": {"rate": 122246},
          "ভিটা": {"rate": 122246},
          "বাগান": {"rate": 43282},
          "পুকুর": {"rate": 115566},
          "ডোবা": {"rate": 115566}
        },
        "jl": "71"
      },
      "মধ্যম মঘাদিয়া পৌর": {
        "rates": {
          "নাল": {"rate": 185180},
          "বাড়ী": {"rate": 185143},
          "ভিটা": {"rate": 185143},
          "বাগান": {"rate": 237528},
          "পুকুর": {"rate": 139508},
          "ডোবা": {"rate": 139508}
        },
        "jl": "71"
      },
      "পশ্চিম ধৈরাছড়া": {
        "rates": {
          "নাল": {"rate": 43969},
          "বাড়ী": {"rate": 43439},
          "ভিটা": {"rate": 43439},
          "বাগান": {"rate": 133484},
          "পুকুর": {"rate": 52044},
          "ডোবা": {"rate": 52044}
        },
        "jl": "72"
      },
      "পূর্ব মঘাদিয়া": {
        "rates": {
          "নাল": {"rate": 140219},
          "বাড়ী": {"rate": 287686},
          "ভিটা": {"rate": 287686},
          "বাগান": {"rate": 35600},
          "পুকুর": {"rate": 76101},
          "ডোবা": {"rate": 76101}
        },
        "jl": "73"
      },
      "পূর্ব মঘাদিয়া পৌর": {
        "rates": {
          "নাল": {"rate": 355573},
          "বাড়ী": {"rate": 561306},
          "ভিটা": {"rate": 561306},
          "পুকুর": {"rate": 334256},
          "ডোবা": {"rate": 334256}
        },
        "jl": "73"
      },
      "গোভনীয়া": {
        "rates": {
          "নাল": {"rate": 86422},
          "বাড়ী": {"rate": 31300},
          "ভিটা": {"rate": 31300},
          "পুকুর": {"rate": 54655},
          "ডোবা": {"rate": 54655}
        },
        "jl": "74"
      },
      "গোভনীয়া পৌর": {
        "rates": {
          "নাল": {"rate": 84826},
          "বাড়ী": {"rate": 195000},
          "ভিটা": {"rate": 195000},
          "পুকুর": {"rate": 87500},
          "ডোবা": {"rate": 87500}
        },
        "jl": "74"
      },
      "পূর্ব ধৈরাছড়া": {
        "rates": {
          "নাল": {"rate": 47725},
          "বাড়ী": {"rate": 72566},
          "ভিটা": {"rate": 72566},
          "পুকুর": {"rate": 87500},
          "ডোবা": {"rate": 87500}
        },
        "jl": "75"
      },
      "পেল মোগরা": {
        "rates": {
          "নাল": {"rate": 56234},
          "বাড়ী": {"rate": 52957},
          "ভিটা": {"rate": 52957},
          "বাগান": {"rate": 12143},
          "পুকুর": {"rate": 44775},
          "ডোবা": {"rate": 44775}
        },
        "jl": "76"
      },
      "দুয়ারু": {
        "rates": {
          "নাল": {"rate": 30239},
          "বাড়ী": {"rate": 199735},
          "ভিটা": {"rate": 199735},
          "বাগান": {"rate": 11605},
          "পুকুর": {"rate": 74095},
          "ডোবা": {"rate": 74095}
        },
        "jl": "77"
      },
      "পূর্ব মায়ানী": {
        "rates": {
          "নাল": {"rate": 51416},
          "বাড়ী": {"rate": 113607},
          "ভিটা": {"rate": 113607},
          "বাগান": {"rate": 22667},
          "পুকুর": {"rate": 75080},
          "ডোবা": {"rate": 75080}
        },
        "jl": "78"
      },
      "পশ্চিম মায়ানী": {
        "rates": {
          "নাল": {"rate": 61310},
          "বাড়ী": {"rate": 119524},
          "ভিটা": {"rate": 119524},
          "বাগান": {"rate": 63333},
          "পুকুর": {"rate": 58804},
          "ডোবা": {"rate": 58804}
        },
        "jl": "79"
      },
      "দক্ষিণ মঘাদিয়া": {
        "rates": {
          "নাল": {"rate": 29042},
          "বাড়ী": {"rate": 38165},
          "ভিটা": {"rate": 38165},
          "বাগান": {"rate": 14566},
          "পুকুর": {"rate": 39660},
          "ডোবা": {"rate": 39660}
        },
        "jl": "80"
      },
      "সাহেরখালী": {
        "rates": {
          "নাল": {"rate": 31567},
          "বাড়ী": {"rate": 37661},
          "ভিটা": {"rate": 37661},
          "বাগান": {"rate": 8525},
          "পুকুর": {"rate": 25094},
          "ডোবা": {"rate": 25094}
        },
        "jl": "81"
      },
      "ভোমখালী": {
        "rates": {
          "নাল": {"rate": 32380},
          "বাড়ী": {"rate": 43023},
          "ভিটা": {"rate": 43023},
          "বাগান": {"rate": 14706},
          "পুকুর": {"rate": 30917},
          "ডোবা": {"rate": 30917}
        },
        "jl": "82"
      },
      "দক্ষিণ মুরাদপুর": {
        "rates": {
          "নাল": {"rate": 38278},
          "বাড়ী": {"rate": 87633},
          "ভিটা": {"rate": 87633},
          "বাগান": {"rate": 10120},
          "পুকুর": {"rate": 36369},
          "ডোবা": {"rate": 36369}
        },
        "jl": "83"
      },
      "হাইতকান্দি": {
        "rates": {
          "নাল": {"rate": 21115},
          "বাড়ী": {"rate": 69744},
          "ভিটা": {"rate": 69744},
          "বাগান": {"rate": 12267},
          "পুকুর": {"rate": 30571},
          "ডোবা": {"rate": 30571}
        },
        "jl": "84"
      },
      "কুরুয়া": {
        "rates": {
          "নাল": {"rate": 59941},
          "বাড়ী": {"rate": 179692},
          "ভিটা": {"rate": 179692},
          "বাগান": {"rate": 133333},
          "পুকুর": {"rate": 31554},
          "ডোবা": {"rate": 31554}
        },
        "jl": "85"
      },
      "ছোট কমলদহ": {
        "rates": {
          "নাল": {"rate": 26839},
          "বাড়ী": {"rate": 74667},
          "ভিটা": {"rate": 74667},
          "বাগান": {"rate": 8000},
          "পুকুর": {"rate": 34000},
          "ডোবা": {"rate": 34000}
        },
        "jl": "86"
      },
      "মাইজগাঁও": {
        "rates": {
          "নাল": {"rate": 71838},
          "বাড়ী": {"rate": 62879},
          "ভিটা": {"rate": 62879},
          "বাগান": {"rate": 56000},
          "পুকুর": {"rate": 55789},
          "ডোবা": {"rate": 55789}
        },
        "jl": "87"
      },
      "গাছবাড়ীয়া": {
        "rates": {
          "নাল": {"rate": 107688},
          "বাড়ী": {"rate": 408186},
          "ভিটা": {"rate": 408186},
          "বাগান": {"rate": 12200},
          "পুকুর": {"rate": 254687},
          "ডোবা": {"rate": 254687}
        },
        "jl": "88"
      },
      "ওয়াহেদ পুর": {
        "rates": {
          "নাল": {"rate": 86000},
          "বাড়ী": {"rate": 139959},
          "ভিটা": {"rate": 139959},
          "বাগান": {"rate": 35088},
          "পুকুর": {"rate": 100879},
          "ডোবা": {"rate": 100879}
        },
        "jl": "89"
      },
      "খাজুরিয়া": {
        "rates": {
          "নাল": {"rate": 32204},
          "বাড়ী": {"rate": 71522},
          "ভিটা": {"rate": 71522},
          "বাগান": {"rate": 8300},
          "পুকুর": {"rate": 107775},
          "ডোবা": {"rate": 107775}
        },
        "jl": "90"
      },
      "জগদীশ পুর": {
        "rates": {
          "নাল": {"rate": 27802},
          "বাড়ী": {"rate": 54838},
          "ভিটা": {"rate": 54838},
          "বাগান": {"rate": 5500},
          "পুকুর": {"rate": 29865},
          "ডোবা": {"rate": 29865}
        },
        "jl": "91"
      },
      "বালিয়াদী": {
        "rates": {
          "নাল": {"rate": 23687},
          "বাড়ী": {"rate": 86115},
          "ভিটা": {"rate": 86115},
          "পুকুর": {"rate": 41522},
          "ডোবা": {"rate": 41522}
        },
        "jl": "92"
      },
      "সাতবাড়ীয়া": {
        "rates": {
          "নাল": {"rate": 21873},
          "বাড়ী": {"rate": 82105},
          "ভিটা": {"rate": 82105},
          "বাগান": {"rate": 38106},
          "পুকুর": {"rate": 59214},
          "ডোবা": {"rate": 59214}
        },
        "jl": "93"
      },
      "বড় কমলদহ": {
        "rates": {
          "নাল": {"rate": 127138},
          "বাড়ী": {"rate": 106545},
          "ভিটা": {"rate": 106545},
          "বাগান": {"rate": 15000},
          "পুকুর": {"rate": 61944},
          "ডোবা": {"rate": 61944}
        },
        "jl": "94"
      },
      "কিছমত জাফরাবাদ": {
        "rates": {
          "নাল": {"rate": 140024},
          "বাড়ী": {"rate": 179310},
          "ভিটা": {"rate": 179310},
          "বাগান": {"rate": 8160},
          "পুকুর": {"rate": 128370},
          "ডোবা": {"rate": 128370}
        },
        "jl": "95/107"
      },
      "কিছমত জাফরাবাদ পৌর": {
        "rates": {
          "নাল": {"rate": 207754},
          "বাড়ী": {"rate": 97664},
          "ভিটা": {"rate": 97664},
          "বাগান": {"rate": 120000},
          "পুকুর": {"rate": 358824},
          "ডোবা": {"rate": 358824}
        },
        "jl": "95/107"
      },
      "চর কালীদাস": {
        "rates": {
          "নাল": {"rate": 1622}
        },
        "jl": "96"
      },
      "রামগড় সীতাকুণ্ড-করৈ": {
        "rates": {},
        "jl": "97"
      },
      "চর হিঙ্গুলী": {
        "rates": {},
        "jl": "98"
      },
      "কাটা পশ্চিম জোয়ারার": {
        "rates": {
          "নাল": {"rate": 6017}
        },
        "jl": "99"
      },
      "চর তুলাতলী": {
        "rates": {},
        "jl": "100"
      }
    }
  },
  anowara: {
    "name": "আনোয়ারা",
    "period": "2025-2026",
    "mouzas": {
      "আনোয়ারা": {
        "rates": {
          "নাল": {"rate": 201158},
          "বাড়ী": {"rate": 567213},
          "ভিটা": {"rate": 335493},
          "বাগান": {"rate": 224499},
          "পুকুর": {"rate": 255006}
        }
      },
      "আইরমঙ্গল": {
        "rates": {
          "নাল": {"rate": 77124},
          "বাড়ী": {"rate": 112197},
          "ভিটা": {"rate": 14000, "p": true},
          "বাগান": {"rate": 13500, "p": true},
          "পুকুর": {"rate": 70915}
        }
      },
      "ইছাখালী": {
        "rates": {
          "নাল": {"rate": 62099},
          "বাড়ী": {"rate": 103168},
          "ভিটা": {"rate": 196000},
          "বাগান": {"rate": 22222, "p": true},
          "পুকুর": {"rate": 60920}
        }
      },
      "উঃ পরুয়া পাড়া": {
        "rates": {
          "নাল": {"rate": 60947},
          "বাড়ী": {"rate": 44232},
          "ভিটা": {"rate": 131579},
          "বাগান": {"rate": 22000, "p": true},
          "পুকুর": {"rate": 71972}
        }
      },
      "জলঘর": {
        "rates": {
          "নাল": {"rate": 99672},
          "বাড়ী": {"rate": 74952, "p": true},
          "ভিটা": {"rate": 64000},
          "বাগান": {"rate": 62460, "p": true},
          "পুকুর": {"rate": 126234}
        }
      },
      "ভবঘাইন": {
        "rates": {
          "নাল": {"rate": 37603},
          "বাড়ী": {"rate": 114029},
          "ভিটা": {"rate": 63993},
          "বাগান": {"rate": 21622, "p": true},
          "পুকুর": {"rate": 36883}
        }
      },
      "কৈখাইন": {
        "rates": {
          "নাল": {"rate": 21845},
          "বাড়ী": {"rate": 41120},
          "ভিটা": {"rate": 14433, "p": true},
          "বাগান": {"rate": 14433, "p": true},
          "পুকুর": {"rate": 41470}
        }
      },
      "কৈনপুরা": {
        "rates": {
          "নাল": {"rate": 43496},
          "বাড়ী": {"rate": 175479},
          "ভিটা": {"rate": 103414},
          "বাগান": {"rate": 15862, "p": true},
          "পুকুর": {"rate": 125670}
        }
      },
      "কেঁয়াগড়": {
        "rates": {
          "নাল": {"rate": 31761},
          "বাড়ী": {"rate": 74163},
          "ভিটা": {"rate": 30246, "p": true},
          "বাগান": {"rate": 33334},
          "পুকুর": {"rate": 27461}
        }
      },
      "কুনিরবিল": {
        "rates": {
          "নাল": {"rate": 33057},
          "বাড়ী": {"rate": 254612},
          "ভিটা": {"rate": 16000, "p": true},
          "বাগান": {"rate": 68493},
          "পুকুর": {"rate": 33529}
        }
      },
      "খাসখামা": {
        "rates": {
          "নাল": {"rate": 42000},
          "বাড়ী": {"rate": 61107},
          "ভিটা": {"rate": 41957, "p": true},
          "বাগান": {"rate": 12692, "p": true},
          "পুকুর": {"rate": 57291}
        }
      },
      "খুরুশ্কুল": {
        "rates": {
          "নাল": {"rate": 47635},
          "বাড়ী": {"rate": 54286},
          "ভিটা": {"rate": 103983},
          "বাগান": {"rate": 14457, "p": true},
          "পুকুর": {"rate": 20229}
        }
      },
      "খোর্দ্দ গহিরা": {
        "rates": {
          "নাল": {"rate": 58772},
          "বাড়ী": {"rate": 193919},
          "ভিটা": {"rate": 12000, "p": true},
          "বাগান": {"rate": 17094},
          "পুকুর": {"rate": 5420}
        }
      },
      "খিলপাড়া": {
        "rates": {
          "নাল": {"rate": 336316},
          "বাড়ী": {"rate": 131429},
          "ভিটা": {"rate": 89375},
          "বাগান": {"rate": 100000, "p": true},
          "পুকুর": {"rate": 133911}
        }
      },
      "গহিরা": {
        "rates": {
          "নাল": {"rate": 30154},
          "বাড়ী": {"rate": 36680},
          "ভিটা": {"rate": 33931},
          "বাগান": {"rate": 31000, "p": true},
          "পুকুর": {"rate": 24314}
        }
      },
      "গুজরা": {
        "rates": {
          "নাল": {"rate": 53402},
          "বাড়ী": {"rate": 81173},
          "ভিটা": {"rate": 48453},
          "বাগান": {"rate": 38800},
          "পুকুর": {"rate": 46806}
        }
      },
      "গোবাদিয়া": {
        "rates": {
          "নাল": {"rate": 103280},
          "বাড়ী": {"rate": 212953},
          "ভিটা": {"rate": 410390},
          "পুকুর": {"rate": 71323}
        }
      },
      "খন্দীপ": {
        "rates": {
          "নাল": {"rate": 235159},
          "বাড়ী": {"rate": 180128},
          "ভিটা": {"rate": 168549},
          "বাগান": {"rate": 217470},
          "পুকুর": {"rate": 70000}
        }
      },
      "গুয়াপঞ্চক": {
        "rates": {
          "নাল": {"rate": 172113},
          "বাড়ী": {"rate": 343298},
          "ভিটা": {"rate": 168818},
          "বাগান": {"rate": 60881},
          "পুকুর": {"rate": 78887},
          "ডোবা": {"rate": 99057, "p": true}
        }
      },
      "চাভরী গুরুত্বপূর্ণ": {
        "rates": {
          "নাল": {"rate": 467765},
          "বাড়ী": {"rate": 238765},
          "ভিটা": {"rate": 166667, "p": true},
          "বাগান": {"rate": 20000, "p": true},
          "পুকুর": {"rate": 769054}
        }
      },
      "চাভরী কম গুরুত্বপূর্ণ": {
        "rates": {
          "নাল": {"rate": 105285},
          "বাড়ী": {"rate": 159894},
          "ভিটা": {"rate": 159626},
          "বাগান": {"rate": 20589},
          "পুকুর": {"rate": 172545}
        }
      },
      "চাঁপাতলী": {
        "rates": {
          "নাল": {"rate": 159644},
          "বাড়ী": {"rate": 223303},
          "ভিটা": {"rate": 187235},
          "বাগান": {"rate": 57204},
          "পুকুর": {"rate": 216265}
        }
      },
      "চালিতাতলী": {
        "rates": {
          "নাল": {"rate": 57103},
          "বাড়ী": {"rate": 71721},
          "ভিটা": {"rate": 173866},
          "পুকুর": {"rate": 28517},
          "ডোবা": {"rate": 88000}
        }
      },
      "চর পুকুরিয়া": {
        "rates": {
          "নাল": {"rate": 25622},
          "বাড়ী": {"rate": 20000, "p": true},
          "ভিটা": {"rate": 18000, "p": true},
          "পুকুর": {"rate": 3500, "p": true}
        }
      },
      "চেনামতি": {
        "rates": {
          "নাল": {"rate": 48050},
          "বাড়ী": {"rate": 8889, "p": true},
          "ভিটা": {"rate": 6571, "p": true},
          "বাগান": {"rate": 7000, "p": true},
          "পুকুর": {"rate": 35587}
        }
      },
      "ছন্নাপাড়া": {
        "rates": {
          "নাল": {"rate": 51535},
          "বাড়ী": {"rate": 61430},
          "ভিটা": {"rate": 75962},
          "বাগান": {"rate": 18207, "p": true},
          "পুকুর": {"rate": 100816}
        }
      },
      "ছিরাবটতলী": {
        "rates": {
          "নাল": {"rate": 8444, "p": true},
          "বাড়ী": {"rate": 22666, "p": true},
          "ভিটা": {"rate": 20031, "p": true},
          "পুকুর": {"rate": 10362, "p": true}
        }
      },
      "জুইদণ্ডী": {
        "rates": {
          "নাল": {"rate": 49325},
          "বাড়ী": {"rate": 68114},
          "ভিটা": {"rate": 175081},
          "বাগান": {"rate": 8713, "p": true},
          "পুকুর": {"rate": 28355}
        }
      },
      "ঝিওরী": {
        "rates": {
          "নাল": {"rate": 123292},
          "বাড়ী": {"rate": 284370},
          "ভিটা": {"rate": 89436},
          "পুকুর": {"rate": 152710}
        }
      },
      "ডুমুরিয়া": {
        "rates": {
          "নাল": {"rate": 58654},
          "বাড়ী": {"rate": 69738},
          "ভিটা": {"rate": 81175},
          "বাগান": {"rate": 87456},
          "পুকুর": {"rate": 62085}
        }
      },
      "তুলাতলী": {
        "rates": {
          "নাল": {"rate": 14166, "p": true},
          "বাড়ী": {"rate": 20208, "p": true},
          "ভিটা": {"rate": 17007, "p": true}
        }
      },
      "তৈলারদ্বীপ": {
        "rates": {
          "নাল": {"rate": 67101},
          "বাড়ী": {"rate": 136427},
          "ভিটা": {"rate": 54630},
          "বাগান": {"rate": 17523},
          "পুকুর": {"rate": 118067}
        }
      },
      "তালসরা": {
        "rates": {
          "নাল": {"rate": 25544},
          "বাড়ী": {"rate": 42353},
          "ভিটা": {"rate": 15952, "p": true},
          "বাগান": {"rate": 84090},
          "পুকুর": {"rate": 35700}
        }
      },
      "তাতুয়া": {
        "rates": {
          "নাল": {"rate": 26518},
          "বাড়ী": {"rate": 18000, "p": true},
          "ভিটা": {"rate": 14771, "p": true},
          "পুকুর": {"rate": 5128, "p": true}
        }
      },
      "তেকোটা": {
        "rates": {
          "নাল": {"rate": 94042},
          "বাড়ী": {"rate": 67842},
          "ভিটা": {"rate": 52125, "p": true},
          "বাগান": {"rate": 17910, "p": true},
          "পুকুর": {"rate": 52954},
          "ডোবা": {"rate": 40541}
        }
      },
      "তিশরী": {
        "rates": {
          "নাল": {"rate": 37849},
          "বাড়ী": {"rate": 111354},
          "ভিটা": {"rate": 14735},
          "বাগান": {"rate": 112000},
          "পুকুর": {"rate": 83888}
        }
      },
      "দেওতলা": {
        "rates": {
          "নাল": {"rate": 53822},
          "বাড়ী": {"rate": 36232},
          "ভিটা": {"rate": 28872, "p": true},
          "বাগান": {"rate": 58334},
          "পুকুর": {"rate": 46781}
        }
      },
      "দঃ পরুয়াপাড়া": {
        "rates": {
          "নাল": {"rate": 32535},
          "বাড়ী": {"rate": 67004},
          "ভিটা": {"rate": 32591},
          "বাগান": {"rate": 21622, "p": true},
          "পুকুর": {"rate": 39468}
        }
      },
      "দুধকুমড়া": {
        "rates": {
          "নাল": {"rate": 59240},
          "বাড়ী": {"rate": 114018},
          "ভিটা": {"rate": 51792},
          "পুকুর": {"rate": 29777}
        }
      },
      "ধানপুরা": {
        "rates": {
          "নাল": {"rate": 52863},
          "বাড়ী": {"rate": 50000},
          "ভিটা": {"rate": 50000, "p": true},
          "বাগান": {"rate": 115384},
          "পুকুর": {"rate": 49100},
          "ডোবা": {"rate": 100000, "p": true}
        }
      },
      "নলদিয়া": {
        "rates": {
          "নাল": {"rate": 42582},
          "বাড়ী": {"rate": 30453},
          "ভিটা": {"rate": 52349},
          "বাগান": {"rate": 16290, "p": true},
          "পুকুর": {"rate": 45715}
        }
      },
      "নৈদভী": {
        "rates": {
          "নাল": {"rate": 32602},
          "বাড়ী": {"rate": 18583, "p": true},
          "ভিটা": {"rate": 15486, "p": true},
          "পুকুর": {"rate": 5500, "p": true}
        }
      },
      "পশ্চিম বরেয়া": {
        "rates": {
          "নাল": {"rate": 51786},
          "বাড়ী": {"rate": 44702},
          "ভিটা": {"rate": 31819},
          "পুকুর": {"rate": 41624}
        }
      },
      "পঃ তুলাতলী": {
        "rates": {
          "নাল": {"rate": 49200, "p": true},
          "বাড়ী": {"rate": 27600, "p": true},
          "ভিটা": {"rate": 23000, "p": true},
          "পুকুর": {"rate": 4210, "p": true}
        }
      },
      "পাটনিকোঠা": {
        "rates": {
          "নাল": {"rate": 38195},
          "বাড়ী": {"rate": 63038},
          "ভিটা": {"rate": 14047, "p": true},
          "বাগান": {"rate": 50000, "p": true},
          "পুকুর": {"rate": 24576}
        }
      },
      "পশ্চিম কন্যারা": {
        "rates": {
          "নাল": {"rate": 77983},
          "বাড়ী": {"rate": 215647},
          "ভিটা": {"rate": 36000, "p": true},
          "বাগান": {"rate": 23143},
          "পুকুর": {"rate": 179295}
        }
      },
      "পরৈকোড়া": {
        "rates": {
          "নাল": {"rate": 44164},
          "বাড়ী": {"rate": 54419},
          "ভিটা": {"rate": 47819},
          "বাগান": {"rate": 58824},
          "পুকুর": {"rate": 57390}
        }
      },
      "পশ্চিমচাল": {
        "rates": {
          "নাল": {"rate": 222456},
          "বাড়ী": {"rate": 408994},
          "ভিটা": {"rate": 348209},
          "বাগান": {"rate": 215114},
          "পুকুর": {"rate": 305130}
        }
      },
      "পূর্ব কন্যারা": {
        "rates": {
          "নাল": {"rate": 46911},
          "বাড়ী": {"rate": 46557},
          "ভিটা": {"rate": 15347, "p": true},
          "বাগান": {"rate": 47928},
          "পুকুর": {"rate": 71244}
        }
      },
      "পীরখাইন": {
        "rates": {
          "নাল": {"rate": 77650},
          "বাড়ী": {"rate": 300625},
          "ভিটা": {"rate": 211621, "p": true},
          "বাগান": {"rate": 300000, "p": true},
          "পুকুর": {"rate": 140370}
        }
      },
      "পূর্ব বরেয়া": {
        "rates": {
          "নাল": {"rate": 63300},
          "বাড়ী": {"rate": 72198},
          "ভিটা": {"rate": 72011},
          "বাগান": {"rate": 31250, "p": true},
          "পুকুর": {"rate": 37377}
        }
      },
      "পূর্ব তুলাতলী": {
        "rates": {
          "নাল": {"rate": 73614},
          "বাড়ী": {"rate": 153750},
          "ভিটা": {"rate": 26667, "p": true},
          "পুকুর": {"rate": 110655},
          "ডোবা": {"rate": 55000, "p": true}
        }
      },
      "ফুলতলী": {
        "rates": {
          "নাল": {"rate": 55754},
          "বাড়ী": {"rate": 52132, "p": true},
          "ভিটা": {"rate": 44087, "p": true},
          "পুকুর": {"rate": 40000}
        }
      },
      "বুরুমচড়া": {
        "rates": {
          "নাল": {"rate": 64192},
          "বাড়ী": {"rate": 127393},
          "ভিটা": {"rate": 203128},
          "বাগান": {"rate": 77131},
          "পুকুর": {"rate": 94254}
        }
      },
      "বাথুয়া পাড়া": {
        "rates": {
          "নাল": {"rate": 26491},
          "বাড়ী": {"rate": 50646},
          "ভিটা": {"rate": 43662},
          "বাগান": {"rate": 16130},
          "পুকুর": {"rate": 16130}
        }
      },
      "বদলপুরা": {
        "rates": {
          "নাল": {"rate": 463923},
          "বাড়ী": {"rate": 126683},
          "ভিটা": {"rate": 93750, "p": true},
          "বাগান": {"rate": 27777, "p": true},
          "পুকুর": {"rate": 85681}
        }
      },
      "বৈরাগ": {
        "rates": {
          "নাল": {"rate": 351282},
          "বাড়ী": {"rate": 377964},
          "ভিটা": {"rate": 299644},
          "বাগান": {"rate": 120171},
          "পুকুর": {"rate": 109741},
          "ডোবা": {"rate": 100000}
        }
      },
      "বটতলী": {
        "rates": {
          "নাল": {"rate": 198603},
          "বাড়ী": {"rate": 521359},
          "ভিটা": {"rate": 328474},
          "বাগান": {"rate": 363514},
          "পুকুর": {"rate": 189936}
        }
      },
      "বেলছড়া": {
        "rates": {
          "নাল": {"rate": 253206},
          "বাড়ী": {"rate": 268000},
          "ভিটা": {"rate": 83460, "p": true},
          "পুকুর": {"rate": 116307}
        }
      },
      "বিলপুর": {
        "rates": {
          "নাল": {"rate": 90935},
          "বাড়ী": {"rate": 66903},
          "ভিটা": {"rate": 78965},
          "বাগান": {"rate": 14667, "p": true},
          "পুকুর": {"rate": 175648}
        }
      },
      "বারশত": {
        "rates": {
          "নাল": {"rate": 85433},
          "বাড়ী": {"rate": 223227},
          "ভিটা": {"rate": 102150},
          "বাগান": {"rate": 200000},
          "পুকুর": {"rate": 153576}
        }
      },
      "বন্দর": {
        "rates": {
          "নাল": {"rate": 185555},
          "বাড়ী": {"rate": 464160},
          "ভিটা": {"rate": 282520},
          "বাগান": {"rate": 24667, "p": true},
          "পুকুর": {"rate": 246112}
        }
      },
      "বোয়ালিয়া": {
        "rates": {
          "নাল": {"rate": 78628},
          "বাড়ী": {"rate": 88164},
          "ভিটা": {"rate": 52073},
          "বাগান": {"rate": 40000},
          "পুকুর": {"rate": 101398}
        }
      },
      "বোয়ালগাঁও": {
        "rates": {
          "নাল": {"rate": 123177},
          "বাড়ী": {"rate": 181739},
          "ভিটা": {"rate": 175439, "p": true},
          "বাগান": {"rate": 25000},
          "পুকুর": {"rate": 39075}
        }
      },
      "বারখাইন": {
        "rates": {
          "নাল": {"rate": 67963},
          "বাড়ী": {"rate": 143248},
          "ভিটা": {"rate": 154027},
          "বাগান": {"rate": 41071},
          "পুকুর": {"rate": 124945}
        }
      },
      "ভিংরোল": {
        "rates": {
          "নাল": {"rate": 85611},
          "বাড়ী": {"rate": 428205},
          "ভিটা": {"rate": 61630},
          "পুকুর": {"rate": 76368},
          "ডোবা": {"rate": 50000, "p": true}
        }
      },
      "মালঘর": {
        "rates": {
          "নাল": {"rate": 93727},
          "বাড়ী": {"rate": 178835},
          "ভিটা": {"rate": 230434},
          "বাগান": {"rate": 38074},
          "পুকুর": {"rate": 175498}
        }
      },
      "মাহাতা": {
        "rates": {
          "নাল": {"rate": 49174},
          "বাড়ী": {"rate": 43840},
          "ভিটা": {"rate": 110000},
          "বাগান": {"rate": 22000, "p": true},
          "পুকুর": {"rate": 51888}
        }
      },
      "মামুরখাইন": {
        "rates": {
          "নাল": {"rate": 41067},
          "বাড়ী": {"rate": 60714},
          "ভিটা": {"rate": 50467, "p": true},
          "বাগান": {"rate": 10240},
          "পুকুর": {"rate": 6866}
        }
      },
      "মাঝের চর": {
        "rates": {
          "নাল": {"rate": 4000, "p": true},
          "বাড়ী": {"rate": 6000, "p": true},
          "ভিটা": {"rate": 5000, "p": true},
          "পুকুর": {"rate": 3112, "p": true}
        }
      },
      "রায়পুর": {
        "rates": {
          "নাল": {"rate": 28807},
          "বাড়ী": {"rate": 58584},
          "ভিটা": {"rate": 60861},
          "পুকুর": {"rate": 14129}
        }
      },
      "রাঙ্গাদিয়া": {
        "rates": {
          "নাল": {"rate": 101264},
          "বাড়ী": {"rate": 75000, "p": true},
          "ভিটা": {"rate": 62500, "p": true},
          "পুকুর": {"rate": 22500, "p": true}
        }
      },
      "রুদুরা": {
        "rates": {
          "নাল": {"rate": 24450},
          "বাড়ী": {"rate": 79700},
          "ভিটা": {"rate": 70333, "p": true},
          "পুকুর": {"rate": 29033}
        }
      },
      "শিলাইগড়া": {
        "rates": {
          "নাল": {"rate": 94401},
          "বাড়ী": {"rate": 110827},
          "ভিটা": {"rate": 135179},
          "পুকুর": {"rate": 67957}
        }
      },
      "শিলালিয়া": {
        "rates": {
          "নাল": {"rate": 35317},
          "বাড়ী": {"rate": 41825},
          "ভিটা": {"rate": 141176, "p": true},
          "বাগান": {"rate": 37181},
          "পুকুর": {"rate": 55663}
        }
      },
      "শোলকাটা": {
        "rates": {
          "নাল": {"rate": 385720},
          "বাড়ী": {"rate": 132850},
          "ভিটা": {"rate": 104046},
          "বাগান": {"rate": 20253},
          "পুকুর": {"rate": 123045}
        }
      },
      "সরেগা": {
        "rates": {
          "নাল": {"rate": 36970},
          "বাড়ী": {"rate": 54761},
          "ভিটা": {"rate": 31303},
          "পুকুর": {"rate": 16796}
        }
      },
      "ছৈয়দ কুচাইয়া": {
        "rates": {
          "নাল": {"rate": 63952},
          "বাড়ী": {"rate": 200000},
          "ভিটা": {"rate": 200000, "p": true},
          "পুকুর": {"rate": 99531}
        }
      },
      "সিংহরা": {
        "rates": {
          "নাল": {"rate": 97011},
          "বাড়ী": {"rate": 165427},
          "ভিটা": {"rate": 113625},
          "পুকুর": {"rate": 130374}
        }
      },
      "সাইটপেটুয়া": {
        "rates": {
          "নাল": {"rate": 59782},
          "বাড়ী": {"rate": 6618, "p": true},
          "ভিটা": {"rate": 59055},
          "পুকুর": {"rate": 3200, "p": true}
        }
      },
      "হাইলধর": {
        "rates": {
          "নাল": {"rate": 83520},
          "বাড়ী": {"rate": 142907},
          "ভিটা": {"rate": 87129},
          "বাগান": {"rate": 206667},
          "পুকুর": {"rate": 58501}
        }
      },
      "হাজীগাঁও": {
        "rates": {
          "নাল": {"rate": 189435},
          "বাড়ী": {"rate": 116848},
          "ভিটা": {"rate": 274830},
          "পুকুর": {"rate": 96647}
        }
      },
      "হেতিখাইন": {
        "rates": {
          "নাল": {"rate": 67640},
          "বাড়ী": {"rate": 157859},
          "ভিটা": {"rate": 203500},
          "বাগান": {"rate": 100000},
          "পুকুর": {"rate": 52854}
        }
      }
    }
  },
  fatikchhari: {
    "name": "ফটিকছড়ি / নানুপুর / কাজিরহাট",
    "period": "2025-2026",
    "mouzas": {
      "আজিম নগর": {
        "rates": {
          "নাল": {"rate": 119168},
          "বাড়ী": {"rate": 67492},
          "ভিটা": {"rate": 67492},
          "বাগান": {"rate": 22710},
          "পুকুর": {"rate": 208143},
          "ডোবা": {"rate": 15500}
        }
      },
      "আজিমপুর": {
        "rates": {
          "নাল": {"rate": 92713},
          "বাড়ী": {"rate": 94590},
          "ভিটা": {"rate": 94590},
          "বাগান": {"rate": 40000, "p": true},
          "পুকুর": {"rate": 75000},
          "ডোবা": {"rate": 121429, "p": true}
        }
      },
      "আন্দার মানিক": {
        "rates": {
          "নাল": {"rate": 1834, "p": true}
        }
      },
      "আবদুল্লাহপুর": {
        "rates": {
          "নাল": {"rate": 53951},
          "বাড়ী": {"rate": 151132},
          "ভিটা": {"rate": 151132},
          "বাগান": {"rate": 13943, "p": true},
          "পুকুর": {"rate": 51185},
          "ডোবা": {"rate": 110910}
        }
      },
      "আমতলী": {
        "rates": {
          "নাল": {"rate": 18484},
          "বাড়ী": {"rate": 67709},
          "ভিটা": {"rate": 67709},
          "বাগান": {"rate": 7000, "p": true},
          "পুকুর": {"rate": 11485},
          "ডোবা": {"rate": 11217}
        }
      },
      "ঈদিলপুর": {
        "rates": {
          "নাল": {"rate": 43484},
          "বাড়ী": {"rate": 36610},
          "ভিটা": {"rate": 36610},
          "বাগান": {"rate": 24168},
          "পুকুর": {"rate": 53287},
          "ডোবা": {"rate": 14166}
        }
      },
      "উ: কাঞ্চন নগর": {
        "rates": {
          "নাল": {"rate": 47547},
          "বাড়ী": {"rate": 101000, "p": true},
          "ভিটা": {"rate": 101000, "p": true}
        }
      },
      "উ: ধুরুং": {
        "rates": {
          "নাল": {"rate": 407492},
          "বাড়ী": {"rate": 1049804},
          "ভিটা": {"rate": 1049804},
          "বাগান": {"rate": 190829},
          "পুকুর": {"rate": 461718},
          "ডোবা": {"rate": 369334}
        }
      },
      "উ: পাইন্দং": {
        "rates": {
          "নাল": {"rate": 54434},
          "বাড়ী": {"rate": 110085},
          "ভিটা": {"rate": 110085},
          "বাগান": {"rate": 455814},
          "পুকুর": {"rate": 352204},
          "ডোবা": {"rate": 42829}
        }
      },
      "উ: বারমাসিয়া": {
        "rates": {
          "নাল": {"rate": 56047},
          "বাড়ী": {"rate": 115117},
          "ভিটা": {"rate": 115117},
          "বাগান": {"rate": 50000, "p": true},
          "পুকুর": {"rate": 31074},
          "ডোবা": {"rate": 15730}
        }
      },
      "উ: রাঙ্গামাটিয়া": {
        "rates": {
          "নাল": {"rate": 323331},
          "বাড়ী": {"rate": 442167},
          "ভিটা": {"rate": 442167},
          "বাগান": {"rate": 200000, "p": true},
          "পুকুর": {"rate": 198051},
          "ডোবা": {"rate": 25000, "p": true}
        }
      },
      "উ: সুন্দরপুর": {
        "rates": {
          "নাল": {"rate": 21085},
          "বাড়ী": {"rate": 37645},
          "ভিটা": {"rate": 37645},
          "বাগান": {"rate": 1500, "p": true},
          "পুকুর": {"rate": 25560},
          "ডোবা": {"rate": 4284}
        }
      },
      "এক খুলিয়া": {
        "rates": {
          "নাল": {"rate": 77505},
          "বাড়ী": {"rate": 89190},
          "ভিটা": {"rate": 89190},
          "পুকুর": {"rate": 112500, "p": true}
        }
      },
      "ওঝরা": {
        "rates": {
          "নাল": {"rate": 110769},
          "বাড়ী": {"rate": 300000, "p": true},
          "ভিটা": {"rate": 300000, "p": true},
          "বাগান": {"rate": 15000, "p": true},
          "পুকুর": {"rate": 147500},
          "ডোবা": {"rate": 20755}
        }
      },
      "কুতুবছড়ি": {
        "rates": {
          "নাল": {"rate": 1500, "p": true}
        }
      },
      "কৃষ্ণ নগর": {
        "rates": {
          "নাল": {"rate": 28429},
          "বাড়ী": {"rate": 80513},
          "ভিটা": {"rate": 80513},
          "বাগান": {"rate": 625000, "p": true},
          "পুকুর": {"rate": 56411},
          "ডোবা": {"rate": 52942, "p": true}
        }
      },
      "কৈয়া পুকুরিয়া": {
        "rates": {
          "নাল": {"rate": 875, "p": true},
          "বাড়ী": {"rate": 750, "p": true},
          "ভিটা": {"rate": 750, "p": true}
        }
      },
      "কোট বাড়ীয়া": {
        "rates": {
          "নাল": {"rate": 61342},
          "বাড়ী": {"rate": 44678},
          "ভিটা": {"rate": 44678},
          "বাগান": {"rate": 16667, "p": true},
          "পুকুর": {"rate": 28533},
          "ডোবা": {"rate": 52000}
        }
      },
      "গামারীতলা": {
        "rates": {
          "নাল": {"rate": 23501},
          "বাড়ী": {"rate": 59285},
          "ভিটা": {"rate": 59285},
          "বাগান": {"rate": 7491, "p": true},
          "পুকুর": {"rate": 53450},
          "ডোবা": {"rate": 13104}
        }
      },
      "গোপাল ঘাটা": {
        "rates": {
          "নাল": {"rate": 16928},
          "বাড়ী": {"rate": 62898},
          "ভিটা": {"rate": 62898},
          "বাগান": {"rate": 44922},
          "পুকুর": {"rate": 66292},
          "ডোবা": {"rate": 30000, "p": true}
        }
      },
      "চাঁদপুর": {
        "rates": {
          "নাল": {"rate": 40244},
          "বাড়ী": {"rate": 133895},
          "ভিটা": {"rate": 133895},
          "বাগান": {"rate": 11268},
          "পুকুর": {"rate": 41419},
          "ডোবা": {"rate": 97736}
        }
      },
      "ছিলোনীয়া": {
        "rates": {
          "নাল": {"rate": 80532},
          "বাড়ী": {"rate": 107585},
          "ভিটা": {"rate": 107585},
          "বাগান": {"rate": 269099},
          "পুকুর": {"rate": 103121},
          "ডোবা": {"rate": 67280}
        }
      },
      "জঙ্গল কৈয়া পুকুরিয়া": {
        "rates": {
          "নাল": {"rate": 21750},
          "বাড়ী": {"rate": 3667},
          "ভিটা": {"rate": 3667},
          "পুকুর": {"rate": 34445}
        }
      },
      "জঙ্গল ঝিরাম": {
        "rates": {
          "নাল": {"rate": 3180, "p": true},
          "বাড়ী": {"rate": 9167, "p": true},
          "ভিটা": {"rate": 9167, "p": true}
        }
      },
      "জঙ্গল শোভনছড়ি": {
        "rates": {
          "নাল": {"rate": 16211},
          "বাড়ী": {"rate": 8334},
          "ভিটা": {"rate": 8334}
        }
      },
      "জঙ্গল দাঁতমারা": {
        "rates": {
          "নাল": {"rate": 12485},
          "বাড়ী": {"rate": 12657},
          "ভিটা": {"rate": 12657},
          "বাগান": {"rate": 6185},
          "পুকুর": {"rate": 2500, "p": true}
        }
      },
      "জঙ্গল হারুয়ালছড়ি": {
        "rates": {
          "নাল": {"rate": 47241},
          "বাড়ী": {"rate": 47215},
          "ভিটা": {"rate": 47215}
        }
      },
      "জাহানপুর": {
        "rates": {
          "নাল": {"rate": 305402},
          "বাড়ী": {"rate": 256000},
          "ভিটা": {"rate": 256000},
          "বাগান": {"rate": 47368, "p": true},
          "পুকুর": {"rate": 141667},
          "ডোবা": {"rate": 93241}
        }
      },
      "জুজখোলা": {
        "rates": {
          "নাল": {"rate": 30296},
          "বাড়ী": {"rate": 130207},
          "ভিটা": {"rate": 130207},
          "বাগান": {"rate": 23750, "p": true},
          "পুকুর": {"rate": 62003},
          "ডোবা": {"rate": 8594}
        }
      },
      "ডলু": {
        "rates": {
          "নাল": {"rate": 11569},
          "বাড়ী": {"rate": 1252},
          "ভিটা": {"rate": 1252},
          "পুকুর": {"rate": 60111, "p": true},
          "ডোবা": {"rate": 5000, "p": true}
        }
      },
      "ভাঁরাখো": {
        "rates": {
          "নাল": {"rate": 19538},
          "বাড়ী": {"rate": 18106},
          "ভিটা": {"rate": 18106},
          "বাগান": {"rate": 23894},
          "পুকুর": {"rate": 63445},
          "ডোবা": {"rate": 12465}
        }
      },
      "তেল পারই": {
        "rates": {
          "নাল": {"rate": 87759},
          "বাড়ী": {"rate": 80728},
          "ভিটা": {"rate": 80728},
          "পুকুর": {"rate": 20000},
          "ডোবা": {"rate": 60353}
        }
      },
      "দমদমা": {
        "rates": {
          "নাল": {"rate": 57104},
          "বাড়ী": {"rate": 103750},
          "ভিটা": {"rate": 103750},
          "বাগান": {"rate": 21333, "p": true},
          "পুকুর": {"rate": 72800},
          "ডোবা": {"rate": 15837}
        }
      },
      "দাঁতমারা": {
        "rates": {
          "নাল": {"rate": 23352},
          "বাড়ী": {"rate": 177023},
          "ভিটা": {"rate": 177023},
          "বাগান": {"rate": 8953},
          "পুকুর": {"rate": 23892},
          "ডোবা": {"rate": 11375}
        }
      },
      "দৌলতপুর": {
        "rates": {
          "নাল": {"rate": 72608},
          "বাড়ী": {"rate": 85040, "p": true},
          "ভিটা": {"rate": 85040, "p": true},
          "বাগান": {"rate": 15250, "p": true},
          "পুকুর": {"rate": 7017},
          "ডোবা": {"rate": 12874, "p": true}
        }
      },
      "দ: কাঞ্চন নগর": {
        "rates": {
          "নাল": {"rate": 97877},
          "বাড়ী": {"rate": 174285},
          "ভিটা": {"rate": 174285},
          "বাগান": {"rate": 66667},
          "পুকুর": {"rate": 267907},
          "ডোবা": {"rate": 164872}
        }
      },
      "দ: ধুরুং": {
        "rates": {
          "নাল": {"rate": 311902},
          "বাড়ী": {"rate": 521741},
          "ভিটা": {"rate": 521741},
          "বাগান": {"rate": 602033},
          "পুকুর": {"rate": 393862},
          "ডোবা": {"rate": 231666}
        }
      },
      "দ: পাইন্দং": {
        "rates": {
          "নাল": {"rate": 104840},
          "বাড়ী": {"rate": 163464},
          "ভিটা": {"rate": 163464},
          "পুকুর": {"rate": 114522},
          "ডোবা": {"rate": 151372}
        }
      },
      "দ: রাঙ্গামাটিয়া": {
        "rates": {
          "নাল": {"rate": 109363},
          "বাড়ী": {"rate": 415085},
          "ভিটা": {"rate": 415085},
          "বাগান": {"rate": 26875, "p": true},
          "পুকুর": {"rate": 102232},
          "ডোবা": {"rate": 329240}
        }
      },
      "দ: সুন্দরপুর": {
        "rates": {
          "নাল": {"rate": 85670},
          "বাড়ী": {"rate": 158210},
          "ভিটা": {"rate": 158210},
          "বাগান": {"rate": 66428},
          "পুকুর": {"rate": 171005},
          "ডোবা": {"rate": 88000}
        }
      },
      "ধর্মপুর": {
        "rates": {
          "নাল": {"rate": 203286},
          "বাড়ী": {"rate": 125856},
          "ভিটা": {"rate": 125856},
          "বাগান": {"rate": 51004},
          "পুকুর": {"rate": 158849},
          "ডোবা": {"rate": 122509}
        }
      },
      "নানুপুর": {
        "rates": {
          "নাল": {"rate": 171667},
          "বাড়ী": {"rate": 316173},
          "ভিটা": {"rate": 316173},
          "বাগান": {"rate": 143778, "p": true},
          "পুকুর": {"rate": 112716},
          "ডোবা": {"rate": 564510}
        }
      },
      "নিচিন্তাপুর": {
        "rates": {
          "নাল": {"rate": 66918},
          "বাড়ী": {"rate": 241786},
          "ভিটা": {"rate": 241786},
          "বাগান": {"rate": 48804},
          "পুকুর": {"rate": 87561},
          "ডোবা": {"rate": 71428, "p": true}
        }
      },
      "প: আন্দার মানিক": {
        "rates": {
          "নাল": {"rate": 19500},
          "বাড়ী": {"rate": 15015},
          "ভিটা": {"rate": 15015},
          "পুকুর": {"rate": 35024},
          "ডোবা": {"rate": 9375, "p": true}
        }
      },
      "প: কৈয়া পুকুরিয়া": {
        "rates": {
          "নাল": {"rate": 12594},
          "বাড়ী": {"rate": 37428},
          "ভিটা": {"rate": 37428},
          "পুকুর": {"rate": 5109},
          "ডোবা": {"rate": 1435, "p": true}
        }
      },
      "প: ঝিরাম": {
        "rates": {
          "নাল": {"rate": 59482},
          "বাড়ী": {"rate": 84842},
          "ভিটা": {"rate": 84842},
          "বাগান": {"rate": 69355},
          "পুকুর": {"rate": 287752},
          "ডোবা": {"rate": 50000}
        }
      },
      "প: ফটিকছড়ি": {
        "rates": {
          "নাল": {"rate": 9586, "p": true},
          "বাড়ী": {"rate": 4158, "p": true},
          "ভিটা": {"rate": 4158, "p": true}
        }
      },
      "প: ভূজপুর": {
        "rates": {
          "নাল": {"rate": 112440},
          "বাড়ী": {"rate": 138858},
          "ভিটা": {"rate": 138858},
          "বাগান": {"rate": 53415},
          "পুকুর": {"rate": 103643},
          "ডোবা": {"rate": 58506}
        }
      },
      "প: মন্দাকিনী": {
        "rates": {
          "নাল": {"rate": 32157},
          "বাড়ী": {"rate": 4000, "p": true},
          "ভিটা": {"rate": 4000, "p": true},
          "পুকুর": {"rate": 31498}
        }
      },
      "পাগলীছড়ি": {
        "rates": {
          "নাল": {"rate": 14097},
          "বাড়ী": {"rate": 25000},
          "ভিটা": {"rate": 25000},
          "পুকুর": {"rate": 33334}
        }
      },
      "পাটিয়ালছড়ি": {
        "rates": {
          "নাল": {"rate": 29654},
          "বাড়ী": {"rate": 66756},
          "ভিটা": {"rate": 66756},
          "পুকুর": {"rate": 37475, "p": true},
          "ডোবা": {"rate": 33027}
        }
      },
      "পিলখানা": {
        "rates": {
          "নাল": {"rate": 6541},
          "বাড়ী": {"rate": 6281},
          "ভিটা": {"rate": 6281},
          "বাগান": {"rate": 3880},
          "পুকুর": {"rate": 3113, "p": true}
        }
      },
      "পূর্ব আধারমানিক": {
        "rates": {
          "নাল": {"rate": 24424},
          "বাড়ী": {"rate": 7037},
          "ভিটা": {"rate": 7037},
          "পুকুর": {"rate": 25200},
          "ডোবা": {"rate": 25000, "p": true}
        }
      },
      "পূর্ব কৈয়াপুকুরিয়া": {
        "rates": {
          "নাল": {"rate": 22135},
          "বাড়ী": {"rate": 9800},
          "ভিটা": {"rate": 9800}
        }
      },
      "পূর্ব ধলই": {
        "rates": {
          "নাল": {"rate": 55158},
          "বাড়ী": {"rate": 113597},
          "ভিটা": {"rate": 113597},
          "বাগান": {"rate": 20000, "p": true},
          "পুকুর": {"rate": 22910},
          "ডোবা": {"rate": 247715}
        }
      },
      "পূর্ব ধুরুং": {
        "rates": {
          "নাল": {"rate": 98428},
          "বাড়ী": {"rate": 106504},
          "ভিটা": {"rate": 106504},
          "বাগান": {"rate": 96992, "p": true},
          "পুকুর": {"rate": 198024},
          "ডোবা": {"rate": 302667}
        }
      },
      "পূর্ব ফটিকছড়ি": {
        "rates": {
          "নাল": {"rate": 30859},
          "বাড়ী": {"rate": 60491},
          "ভিটা": {"rate": 60491},
          "বাগান": {"rate": 6667, "p": true},
          "পুকুর": {"rate": 138705},
          "ডোবা": {"rate": 18750, "p": true}
        }
      },
      "পূর্ব ফরহাদাবাদ": {
        "rates": {
          "নাল": {"rate": 508666},
          "বাড়ী": {"rate": 757611},
          "ভিটা": {"rate": 757611},
          "বাগান": {"rate": 39445},
          "পুকুর": {"rate": 561582},
          "ডোবা": {"rate": 136143}
        }
      },
      "পূর্ব ভূজপুর": {
        "rates": {
          "নাল": {"rate": 184287},
          "বাড়ী": {"rate": 320540},
          "ভিটা": {"rate": 320540},
          "বাগান": {"rate": 18375, "p": true},
          "পুকুর": {"rate": 131840},
          "ডোবা": {"rate": 44965}
        }
      },
      "পাঁচ পুকুরিয়া": {
        "rates": {
          "নাল": {"rate": 99928},
          "বাড়ী": {"rate": 154058},
          "ভিটা": {"rate": 154058},
          "পুকুর": {"rate": 102298},
          "ডোবা": {"rate": 250000, "p": true}
        }
      },
      "প্রেমপুর": {
        "rates": {
          "নাল": {"rate": 27271},
          "বাড়ী": {"rate": 9862},
          "ভিটা": {"rate": 9862},
          "বাগান": {"rate": 7564},
          "পুকুর": {"rate": 42670},
          "ডোবা": {"rate": 1765, "p": true}
        }
      },
      "ফকিরাচাঁন": {
        "rates": {
          "নাল": {"rate": 93661},
          "বাড়ী": {"rate": 108956},
          "ভিটা": {"rate": 108956},
          "পুকুর": {"rate": 62059},
          "ডোবা": {"rate": 43769}
        }
      },
      "ফতেপুর": {
        "rates": {
          "নাল": {"rate": 87747},
          "বাড়ী": {"rate": 349613},
          "ভিটা": {"rate": 349613},
          "বাগান": {"rate": 255814, "p": true},
          "পুকুর": {"rate": 314479},
          "ডোবা": {"rate": 200000}
        }
      },
      "ফেনুয়া": {
        "rates": {
          "নাল": {"rate": 10622},
          "বাড়ী": {"rate": 3776, "p": true},
          "ভিটা": {"rate": 3776, "p": true},
          "পুকুর": {"rate": 8046, "p": true}
        }
      },
      "বঙ্গপুর": {
        "rates": {
          "নাল": {"rate": 71991},
          "বাড়ী": {"rate": 155981},
          "ভিটা": {"rate": 155981},
          "বাগান": {"rate": 114050},
          "পুকুর": {"rate": 135611},
          "ডোবা": {"rate": 18900}
        }
      },
      "বাদুরঝীল": {
        "rates": {
          "নাল": {"rate": 9681},
          "বাড়ী": {"rate": 20910},
          "ভিটা": {"rate": 20910}
        }
      },
      "বারমাসিয়া": {
        "rates": {
          "নাল": {"rate": 64000},
          "বাড়ী": {"rate": 61375},
          "ভিটা": {"rate": 61375},
          "পুকুর": {"rate": 41294},
          "ডোবা": {"rate": 38000}
        }
      },
      "বেতুয়া": {
        "rates": {
          "নাল": {"rate": 9849},
          "বাড়ী": {"rate": 55213},
          "ভিটা": {"rate": 55213},
          "পুকুর": {"rate": 34304}
        }
      },
      "মগ কাটা": {
        "rates": {
          "নাল": {"rate": 16377},
          "বাড়ী": {"rate": 10040},
          "ভিটা": {"rate": 10040},
          "পুকুর": {"rate": 2728, "p": true}
        }
      },
      "মধ্য কাঞ্চন নগর": {
        "rates": {
          "নাল": {"rate": 78932},
          "বাড়ী": {"rate": 173698},
          "ভিটা": {"rate": 173698},
          "বাগান": {"rate": 38750},
          "পুকুর": {"rate": 115100},
          "ডোবা": {"rate": 71309}
        }
      },
      "মাইজভাণ্ডার": {
        "rates": {
          "নাল": {"rate": 172165},
          "বাড়ী": {"rate": 1126190},
          "ভিটা": {"rate": 1126190},
          "পুকুর": {"rate": 171795},
          "ডোবা": {"rate": 33334}
        }
      },
      "মানিকপুর": {
        "rates": {
          "নাল": {"rate": 66261},
          "বাড়ী": {"rate": 168195},
          "ভিটা": {"rate": 168195},
          "বাগান": {"rate": 23530, "p": true},
          "পুকুর": {"rate": 148746},
          "ডোবা": {"rate": 30367}
        }
      },
      "রঙ্গছড়ি": {
        "rates": {}
      },
      "রামগড়": {
        "rates": {
          "নাল": {"rate": 13009},
          "বাড়ী": {"rate": 39396},
          "ভিটা": {"rate": 39396},
          "বাগান": {"rate": 24573},
          "পুকুর": {"rate": 40951},
          "ডোবা": {"rate": 350000, "p": true}
        }
      },
      "রামপুর": {
        "rates": {
          "নাল": {"rate": 22633},
          "বাড়ী": {"rate": 147445},
          "ভিটা": {"rate": 147445},
          "বাগান": {"rate": 25279},
          "পুকুর": {"rate": 49000},
          "ডোবা": {"rate": 151250}
        }
      },
      "রোসাংগিরী": {
        "rates": {
          "নাল": {"rate": 91561},
          "বাড়ী": {"rate": 133218},
          "ভিটা": {"rate": 133218},
          "বাগান": {"rate": 96000, "p": true},
          "পুকুর": {"rate": 105805},
          "ডোবা": {"rate": 46023}
        }
      },
      "লট-উদালিয়া": {
        "rates": {
          "নাল": {"rate": 11112, "p": true},
          "পুকুর": {"rate": 2667, "p": true}
        }
      },
      "লট-বারমাসিয়া": {
        "rates": {
          "নাল": {"rate": 7894, "p": true},
          "বাড়ী": {"rate": 16667, "p": true},
          "ভিটা": {"rate": 16667, "p": true}
        }
      },
      "লট-সুজনগর": {
        "rates": {}
      },
      "লেলাং": {
        "rates": {
          "নাল": {"rate": 74137},
          "বাড়ী": {"rate": 134839},
          "ভিটা": {"rate": 134839},
          "বাগান": {"rate": 58803},
          "পুকুর": {"rate": 76315},
          "ডোবা": {"rate": 91279}
        }
      },
      "শৈল কোপা": {
        "rates": {
          "নাল": {"rate": 29970},
          "বাড়ী": {"rate": 17194},
          "ভিটা": {"rate": 17194},
          "বাগান": {"rate": 85353},
          "পুকুর": {"rate": 12673},
          "ডোবা": {"rate": 15867, "p": true}
        }
      },
      "শ্বেত কূয়া": {
        "rates": {
          "নাল": {"rate": 60765},
          "বাড়ী": {"rate": 10834, "p": true},
          "ভিটা": {"rate": 10834, "p": true},
          "পুকুর": {"rate": 38573},
          "ডোবা": {"rate": 10000, "p": true}
        }
      },
      "শোভনছড়ি": {
        "rates": {
          "নাল": {"rate": 97808},
          "বাড়ী": {"rate": 41017},
          "ভিটা": {"rate": 41017},
          "বাগান": {"rate": 6091, "p": true},
          "পুকুর": {"rate": 15753}
        }
      },
      "সিংহরিয়া": {
        "rates": {
          "নাল": {"rate": 30646},
          "বাড়ী": {"rate": 54457},
          "ভিটা": {"rate": 54457},
          "বাগান": {"rate": 6000, "p": true},
          "পুকুর": {"rate": 40244},
          "ডোবা": {"rate": 50542}
        }
      },
      "সুয়াবিল": {
        "rates": {
          "নাল": {"rate": 65843},
          "বাড়ী": {"rate": 124506},
          "ভিটা": {"rate": 124506},
          "বাগান": {"rate": 35284},
          "পুকুর": {"rate": 78464},
          "ডোবা": {"rate": 74430}
        }
      },
      "সোনাইরখিল": {
        "rates": {
          "নাল": {"rate": 6236},
          "বাড়ী": {"rate": 4568},
          "ভিটা": {"rate": 4568},
          "পুকুর": {"rate": 1750}
        }
      },
      "হরিণা": {
        "rates": {
          "নাল": {"rate": 26102},
          "বাড়ী": {"rate": 31295},
          "ভিটা": {"rate": 31295},
          "পুকুর": {"rate": 30000}
        }
      },
      "হাইদচকিয়া": {
        "rates": {
          "নাল": {"rate": 133933},
          "বাড়ী": {"rate": 102457},
          "ভিটা": {"rate": 102457},
          "বাগান": {"rate": 121333, "p": true},
          "পুকুর": {"rate": 102720},
          "ডোবা": {"rate": 120000, "p": true}
        }
      },
      "হাজিরখিল": {
        "rates": {
          "নাল": {"rate": 21514},
          "বাড়ী": {"rate": 142858},
          "ভিটা": {"rate": 142858},
          "পুকুর": {"rate": 25523},
          "ডোবা": {"rate": 37500, "p": true}
        }
      },
      "হাঁপানিয়া": {
        "rates": {
          "নাল": {"rate": 25947},
          "বাড়ী": {"rate": 47907},
          "ভিটা": {"rate": 47907},
          "বাগান": {"rate": 20000, "p": true},
          "পুকুর": {"rate": 32175},
          "ডোবা": {"rate": 60000}
        }
      },
      "হারুয়ালছড়ি": {
        "rates": {
          "নাল": {"rate": 49582},
          "বাড়ী": {"rate": 80212},
          "ভিটা": {"rate": 80212},
          "বাগান": {"rate": 3000, "p": true},
          "পুকুর": {"rate": 67079},
          "ডোবা": {"rate": 14786}
        }
      },
      "হাছনাবাদ": {
        "rates": {
          "নাল": {"rate": 22952},
          "বাড়ী": {"rate": 59847},
          "ভিটা": {"rate": 59847},
          "বাগান": {"rate": 14124},
          "পুকুর": {"rate": 21210},
          "ডোবা": {"rate": 41090}
        }
      },
      "লট ৯৮ আন্দার মানিক": {
        "rates": {
          "নাল": {"rate": 2500, "p": true}
        }
      },
      "আরাজী ফেনুয়া": {
        "rates": {
          "নাল": {"rate": 22667, "p": true}
        }
      },
      "লট ৭১-এ উদালিয়া": {
        "rates": {
          "নাল": {"rate": 74152},
          "বাড়ী": {"rate": 10000, "p": true},
          "ভিটা": {"rate": 10000, "p": true}
        }
      },
      "লট ১৬ বারমাসিয়া": {
        "rates": {
          "নাল": {"rate": 9695},
          "বাড়ী": {"rate": 16632},
          "ভিটা": {"rate": 16632},
          "পুকুর": {"rate": 8547, "p": true},
          "ডোবা": {"rate": 8929, "p": true}
        }
      },
      "লট ১৯ কুতুবছড়ি": {
        "rates": {
          "নাল": {"rate": 2087}
        }
      },
      "লট ফেনুয়া": {
        "rates": {
          "নাল": {"rate": 2083, "p": true}
        }
      }
    }
  },
  'hathazari-fateyabad': {
    "name": "হাটহাজারী ও ফতেয়াবাদ",
    "period": "2025-2026",
    "mouzas": {
      "আলীপুর": {
        "rates": {
          "নাল": {"rate": 590008},
          "ভিটা": {"rate": 1175696},
          "বাগান": {"rate": 175887},
          "পুকুর": {"rate": 810000},
          "ডোবা": {"rate": 810000}
        }
      },
      "আন্দরঘোনা": {
        "rates": {
          "নাল": {"rate": 41500},
          "ভিটা": {"rate": 41500, "p": true},
          "বাগান": {"rate": 1000, "p": true},
          "পুকুর": {"rate": 1850, "p": true},
          "ডোবা": {"rate": 1850, "p": true}
        }
      },
      "উত্তর পাহাড়তলী": {
        "rates": {
          "নাল": {"rate": 54832},
          "ভিটা": {"rate": 99259},
          "বাগান": {"rate": 53071},
          "পুকুর": {"rate": 76097},
          "ডোবা": {"rate": 76097}
        }
      },
      "উদালিয়া": {
        "rates": {
          "নাল": {"rate": 60483},
          "ভিটা": {"rate": 74422},
          "বাগান": {"rate": 46912},
          "পুকুর": {"rate": 80135},
          "ডোবা": {"rate": 80135}
        }
      },
      "এনায়েতপুর": {
        "rates": {
          "নাল": {"rate": 148271},
          "ভিটা": {"rate": 318064},
          "বাগান": {"rate": 176631},
          "পুকুর": {"rate": 113016},
          "ডোবা": {"rate": 113016}
        }
      },
      "গুমানমর্দন": {
        "rates": {
          "নাল": {"rate": 71821},
          "ভিটা": {"rate": 98960},
          "বাগান": {"rate": 88500},
          "পুকুর": {"rate": 87915},
          "ডোবা": {"rate": 87915}
        }
      },
      "চারিয়া": {
        "rates": {
          "নাল": {"rate": 154861},
          "ভিটা": {"rate": 357323},
          "বাগান": {"rate": 108686},
          "পুকুর": {"rate": 177828},
          "ডোবা": {"rate": 177828}
        }
      },
      "ছোট কাঞ্চনপুর": {
        "rates": {
          "নাল": {"rate": 72883},
          "ভিটা": {"rate": 47118},
          "বাগান": {"rate": 62692},
          "পুকুর": {"rate": 26760, "p": true},
          "ডোবা": {"rate": 26760, "p": true}
        }
      },
      "ছনখোলা": {
        "rates": {
          "নাল": {"rate": 11753},
          "ভিটা": {"rate": 9000, "p": true},
          "বাগান": {"rate": 2515, "p": true},
          "পুকুর": {"rate": 10040, "p": true},
          "ডোবা": {"rate": 10040, "p": true}
        }
      },
      "ছিপাতলী": {
        "rates": {
          "নাল": {"rate": 105213},
          "ভিটা": {"rate": 159033},
          "বাগান": {"rate": 137464},
          "পুকুর": {"rate": 106633},
          "ডোবা": {"rate": 106633}
        }
      },
      "জঙ্গল উদালিয়া": {
        "rates": {
          "নাল": {"rate": 13675},
          "ভিটা": {"rate": 10000, "p": true},
          "বাগান": {"rate": 64546, "p": true},
          "পুকুর": {"rate": 1800, "p": true},
          "ডোবা": {"rate": 1800, "p": true}
        }
      },
      "জঙ্গল উঃ পাহাড়তলী": {
        "rates": {
          "নাল": {"rate": 16840},
          "ভিটা": {"rate": 16842},
          "বাগান": {"rate": 11259},
          "পুকুর": {"rate": 1500, "p": true},
          "ডোবা": {"rate": 1500, "p": true}
        }
      },
      "জঙ্গল চরিয়া": {
        "rates": {
          "নাল": {"rate": 14863},
          "ভিটা": {"rate": 14100, "p": true},
          "বাগান": {"rate": 1132, "p": true},
          "পুকুর": {"rate": 1500, "p": true},
          "ডোবা": {"rate": 1500, "p": true}
        }
      },
      "জঙ্গল শিলছড়ি": {
        "rates": {
          "নাল": {"rate": 15668},
          "ভিটা": {"rate": 15700, "p": true},
          "বাগান": {"rate": 4618, "p": true},
          "পুকুর": {"rate": 1500, "p": true},
          "ডোবা": {"rate": 1500, "p": true}
        }
      },
      "দেওয়ান নগর (সিট নং-০১)": {
        "rates": {
          "নাল": {"rate": 182243},
          "ভিটা": {"rate": 316898},
          "বাগান": {"rate": 235712},
          "পুকুর": {"rate": 120588, "p": true},
          "ডোবা": {"rate": 120588, "p": true}
        }
      },
      "দেওয়ান নগর (সিট নং-০২)": {
        "rates": {
          "নাল": {"rate": 317894},
          "ভিটা": {"rate": 435421},
          "বাগান": {"rate": 321825},
          "পুকুর": {"rate": 425266},
          "ডোবা": {"rate": 425266}
        }
      },
      "দেওয়ান নগর (সিট নং-০৩)": {
        "rates": {
          "নাল": {"rate": 804258},
          "ভিটা": {"rate": 2649766},
          "বাগান": {"rate": 593527},
          "পুকুর": {"rate": 855191},
          "ডোবা": {"rate": 855191}
        }
      },
      "নাঙ্গলমোড়া": {
        "rates": {
          "নাল": {"rate": 162442},
          "ভিটা": {"rate": 250552},
          "বাগান": {"rate": 220034},
          "পুকুর": {"rate": 201511},
          "ডোবা": {"rate": 201511}
        }
      },
      "পূর্ব মন্দাকিনী": {
        "rates": {
          "নাল": {"rate": 215033},
          "ভিটা": {"rate": 313694},
          "বাগান": {"rate": 153883},
          "পুকুর": {"rate": 194754},
          "ডোবা": {"rate": 194754}
        }
      },
      "পশ্চিম ফরহাদাবাদ": {
        "rates": {
          "নাল": {"rate": 242945},
          "ভিটা": {"rate": 237227},
          "বাগান": {"rate": 177452},
          "পুকুর": {"rate": 151485},
          "ডোবা": {"rate": 151485}
        }
      },
      "পশ্চিম ধলই": {
        "rates": {
          "নাল": {"rate": 144880},
          "ভিটা": {"rate": 194522},
          "বাগান": {"rate": 173221},
          "পুকুর": {"rate": 164230},
          "ডোবা": {"rate": 164230}
        }
      },
      "ফটিকা (সিট নং-৪)": {
        "rates": {
          "নাল": {"rate": 1267345},
          "ভিটা": {"rate": 1910403},
          "বাগান": {"rate": 1351964},
          "পুকুর": {"rate": 1064146},
          "ডোবা": {"rate": 1064146}
        }
      },
      "ফটিকা (সিট নং-৩ ও ৫)": {
        "rates": {
          "নাল": {"rate": 467711},
          "ভিটা": {"rate": 759595},
          "বাগান": {"rate": 409938},
          "পুকুর": {"rate": 892471},
          "ডোবা": {"rate": 892471}
        }
      },
      "ফটিকা (সিট নং-১৩ ও ২)": {
        "rates": {
          "নাল": {"rate": 122123},
          "ভিটা": {"rate": 206503},
          "বাগান": {"rate": 166667},
          "পুকুর": {"rate": 177586},
          "ডোবা": {"rate": 177586}
        }
      },
      "মাহমুদাবাদ": {
        "rates": {
          "নাল": {"rate": 106307},
          "ভিটা": {"rate": 90500},
          "বাগান": {"rate": 26516, "p": true},
          "পুকুর": {"rate": 85151},
          "ডোবা": {"rate": 85151}
        }
      },
      "মির্জাপুর": {
        "rates": {
          "নাল": {"rate": 194784},
          "ভিটা": {"rate": 426658},
          "বাগান": {"rate": 156680},
          "পুকুর": {"rate": 246950},
          "ডোবা": {"rate": 246950}
        }
      },
      "মধ্য পাহাড়তলী": {
        "rates": {
          "নাল": {"rate": 185914},
          "ভিটা": {"rate": 400830},
          "বাগান": {"rate": 102740, "p": true},
          "পুকুর": {"rate": 359201},
          "ডোবা": {"rate": 359201}
        }
      },
      "মেখল": {
        "rates": {
          "নাল": {"rate": 222072},
          "ভিটা": {"rate": 366011},
          "বাগান": {"rate": 302992},
          "পুকুর": {"rate": 229436},
          "ডোবা": {"rate": 229436}
        }
      },
      "মোজাফফরপুর": {
        "rates": {
          "নাল": {"rate": 226712},
          "ভিটা": {"rate": 207116},
          "বাগান": {"rate": 177000},
          "পুকুর": {"rate": 177640},
          "ডোবা": {"rate": 177640}
        }
      },
      "রহিমপুর": {
        "rates": {
          "নাল": {"rate": 249438},
          "ভিটা": {"rate": 372460},
          "বাগান": {"rate": 161663},
          "পুকুর": {"rate": 93223},
          "ডোবা": {"rate": 93223}
        }
      },
      "রুহুল্লাপুর": {
        "rates": {
          "নাল": {"rate": 302372},
          "ভিটা": {"rate": 389594},
          "বাগান": {"rate": 166666},
          "পুকুর": {"rate": 441233},
          "ডোবা": {"rate": 441233}
        }
      },
      "শিলছড়ি": {
        "rates": {
          "নাল": {"rate": 38594},
          "বাগান": {"rate": 35320}
        }
      },
      "হাসিম নগর": {
        "rates": {
          "নাল": {"rate": 58553},
          "ভিটা": {"rate": 218835},
          "বাগান": {"rate": 1550, "p": true},
          "পুকুর": {"rate": 68334, "p": true},
          "ডোবা": {"rate": 68334, "p": true}
        }
      },
      "গড়দুয়ারা": {
        "rates": {
          "নাল": {"rate": 116915},
          "ভিটা": {"rate": 202415},
          "বাগান": {"rate": 75740},
          "পুকুর": {"rate": 150085},
          "ডোবা": {"rate": 150085}
        }
      },
      "জোবরা": {
        "rates": {
          "নাল": {"rate": 604319},
          "ভিটা": {"rate": 978327},
          "বাগান": {"rate": 422000, "p": true},
          "পুকুর": {"rate": 421383},
          "ডোবা": {"rate": 421383}
        }
      },
      "পশ্চিম পটি": {
        "rates": {
          "নাল": {"rate": 451889},
          "ভিটা": {"rate": 708477},
          "বাগান": {"rate": 479786},
          "পুকুর": {"rate": 513206},
          "ডোবা": {"rate": 513206}
        }
      },
      "মাইজ পটি": {
        "rates": {
          "নাল": {"rate": 528451},
          "ভিটা": {"rate": 572749},
          "বাগান": {"rate": 313967},
          "পুকুর": {"rate": 285492},
          "ডোবা": {"rate": 285492}
        }
      },
      "মিঠানালা": {
        "rates": {
          "নাল": {"rate": 126549},
          "ভিটা": {"rate": 295625},
          "বাগান": {"rate": 8000},
          "পুকুর": {"rate": 104220},
          "ডোবা": {"rate": 104220}
        }
      },
      "মিঠাছড়া": {
        "rates": {
          "নাল": {"rate": 325025},
          "ভিটা": {"rate": 829403},
          "বাগান": {"rate": 133600},
          "পুকুর": {"rate": 150000, "p": true},
          "ডোবা": {"rate": 150000, "p": true}
        }
      },
      "উত্তর মাদার্শা": {
        "rates": {
          "নাল": {"rate": 123892},
          "ভিটা": {"rate": 161454},
          "বাগান": {"rate": 201445},
          "পুকুর": {"rate": 220326},
          "ডোবা": {"rate": 220326}
        }
      },
      "মধ্য মাদার্শা": {
        "rates": {
          "নাল": {"rate": 239789},
          "ভিটা": {"rate": 468958},
          "বাগান": {"rate": 304220},
          "পুকুর": {"rate": 204032},
          "ডোবা": {"rate": 204032}
        }
      },
      "দক্ষিণ মাদার্শা": {
        "rates": {
          "নাল": {"rate": 368032},
          "ভিটা": {"rate": 545278},
          "বাগান": {"rate": 269621},
          "পুকুর": {"rate": 424027},
          "ডোবা": {"rate": 424027}
        }
      },
      "নেহালপুর": {
        "rates": {
          "নাল": {"rate": 64205},
          "ভিটা": {"rate": 276985},
          "বাগান": {"rate": 255014},
          "পুকুর": {"rate": 147865},
          "ডোবা": {"rate": 147865}
        }
      },
      "চিকনদণ্ডী": {
        "rates": {
          "নাল": {"rate": 464803},
          "ভিটা": {"rate": 833077},
          "বাগান": {"rate": 619483},
          "পুকুর": {"rate": 452802},
          "ডোবা": {"rate": 452802}
        }
      },
      "খন্দকিয়া": {
        "rates": {
          "নাল": {"rate": 404829},
          "ভিটা": {"rate": 730588},
          "বাগান": {"rate": 425807},
          "পুকুর": {"rate": 321035},
          "ডোবা": {"rate": 321035}
        }
      },
      "শিকারপুর": {
        "rates": {
          "নাল": {"rate": 170638},
          "ভিটা": {"rate": 649429},
          "বাগান": {"rate": 240058},
          "পুকুর": {"rate": 178742},
          "ডোবা": {"rate": 178742}
        }
      },
      "বুড়িশ্চর": {
        "rates": {
          "নাল": {"rate": 521534},
          "ভিটা": {"rate": 733916},
          "বাগান": {"rate": 609221},
          "পুকুর": {"rate": 416357},
          "ডোবা": {"rate": 416357}
        }
      },
      "কুয়াইশ": {
        "rates": {
          "নাল": {"rate": 515565},
          "ভিটা": {"rate": 755892},
          "বাগান": {"rate": 475515},
          "পুকুর": {"rate": 414408},
          "ডোবা": {"rate": 414408}
        }
      },
      "বাথুয়া": {
        "rates": {
          "নাল": {"rate": 168844},
          "ভিটা": {"rate": 834981},
          "বাগান": {"rate": 256184},
          "পুকুর": {"rate": 280032},
          "ডোবা": {"rate": 280032}
        }
      },
      "দক্ষিণ পাহাড়তলী": {
        "rates": {
          "নাল": {"rate": 416770},
          "ভিটা": {"rate": 924578},
          "বাগান": {"rate": 369518},
          "পুকুর": {"rate": 370436},
          "ডোবা": {"rate": 370436}
        }
      },
      "জঙ্গল দক্ষিণ পাহাড়তলী": {
        "rates": {
          "নাল": {"rate": 122478},
          "ভিটা": {"rate": 264346},
          "বাগান": {"rate": 214097},
          "পুকুর": {"rate": 111843},
          "ডোবা": {"rate": 111843}
        }
      },
      "জঙ্গল মিঠাছড়া": {
        "rates": {
          "নাল": {"rate": 25409},
          "ভিটা": {"rate": 25500, "p": true},
          "বাগান": {"rate": 5076, "p": true},
          "পুকুর": {"rate": 1417, "p": true},
          "ডোবা": {"rate": 1417, "p": true}
        }
      },
      "জঙ্গল পশ্চিম পটি": {
        "rates": {
          "নাল": {"rate": 7696, "p": true},
          "ভিটা": {"rate": 7700, "p": true},
          "বাগান": {"rate": 1000, "p": true},
          "পুকুর": {"rate": 1000, "p": true},
          "ডোবা": {"rate": 1000, "p": true}
        }
      },
      "জঙ্গল দঃ মিঠাছড়া": {
        "rates": {}
      }
    }
  },
  satkania: {
    "name": "সাতকানিয়া",
    "period": "2025-2026",
    "mouzas": {
      "আজিমপুর": {
        "rates": {
          "নাল": {"rate": 93191},
          "ভিটা": {"rate": 87600},
          "বাগান": {"rate": 50000},
          "পুকুর": {"rate": 61980}
        }
      },
      "আফজল নগর": {
        "rates": {
          "নাল": {"rate": 187562},
          "ভিটা": {"rate": 120211},
          "বাগান": {"rate": 66858},
          "পুকুর": {"rate": 73650}
        }
      },
      "আমিনাইষ": {
        "rates": {
          "নাল": {"rate": 62398},
          "ভিটা": {"rate": 163387},
          "বাগান": {"rate": 392554},
          "পুকুর": {"rate": 145381}
        }
      },
      "আলমগীর": {
        "rates": {
          "নাল": {"rate": 47759},
          "ভিটা": {"rate": 65715},
          "বাগান": {"rate": 88235, "p": true},
          "পুকুর": {"rate": 25778, "p": true}
        }
      },
      "আলীনগর": {
        "rates": {
          "নাল": {"rate": 87033},
          "ভিটা": {"rate": 112863},
          "বাগান": {"rate": 92523, "p": true},
          "পুকুর": {"rate": 54404}
        }
      },
      "ইছামতি": {
        "rates": {
          "নাল": {"rate": 89361},
          "ভিটা": {"rate": 155171},
          "বাগান": {"rate": 129814, "p": true},
          "পুকুর": {"rate": 102332}
        }
      },
      "উত্তর ঢেমশা": {
        "rates": {
          "নাল": {"rate": 244698},
          "ভিটা": {"rate": 407340},
          "বাগান": {"rate": 457282},
          "পুকুর": {"rate": 314678}
        }
      },
      "উত্তর পুটিবিলা": {
        "rates": {
          "নাল": {"rate": 21120},
          "ভিটা": {"rate": 17062, "p": true},
          "পুকুর": {"rate": 2000, "p": true}
        }
      },
      "উত্তর ব্রাহ্মণডেঙ্গা": {
        "rates": {
          "নাল": {"rate": 25420},
          "ভিটা": {"rate": 45938},
          "বাগান": {"rate": 73760},
          "পুকুর": {"rate": 66667}
        }
      },
      "এওচিয়া": {
        "rates": {
          "নাল": {"rate": 121331},
          "ভিটা": {"rate": 161368},
          "বাগান": {"rate": 168509},
          "পুকুর": {"rate": 238445}
        }
      },
      "করাইয়া নগর": {
        "rates": {
          "নাল": {"rate": 79993},
          "ভিটা": {"rate": 109643},
          "বাগান": {"rate": 60651},
          "পুকুর": {"rate": 71535}
        }
      },
      "কাটগড়": {
        "rates": {
          "নাল": {"rate": 207159},
          "ভিটা": {"rate": 334622},
          "বাগান": {"rate": 54758, "p": true},
          "পুকুর": {"rate": 139338}
        }
      },
      "কাঞ্চনা": {
        "rates": {
          "নাল": {"rate": 93985},
          "ভিটা": {"rate": 104892},
          "বাগান": {"rate": 138400},
          "পুকুর": {"rate": 125858},
          "ডোবা": {"rate": 100000}
        }
      },
      "কালিয়াইশ": {
        "rates": {
          "নাল": {"rate": 138291},
          "ভিটা": {"rate": 422563},
          "বাগান": {"rate": 50472},
          "পুকুর": {"rate": 130421},
          "ডোবা": {"rate": 181333, "p": true}
        }
      },
      "কেঁওচিয়া": {
        "rates": {
          "নাল": {"rate": 142204},
          "ভিটা": {"rate": 153071},
          "বাগান": {"rate": 128571, "p": true},
          "পুকুর": {"rate": 63847}
        }
      },
      "কেচুয়ানালা": {
        "rates": {
          "নাল": {"rate": 9170},
          "ভিটা": {"rate": 11979, "p": true},
          "পুকুর": {"rate": 6388, "p": true}
        }
      },
      "কোদালা": {
        "rates": {
          "নাল": {"rate": 15032},
          "ভিটা": {"rate": 8785, "p": true},
          "পুকুর": {"rate": 4078, "p": true}
        }
      },
      "খাগরিয়া": {
        "rates": {
          "নাল": {"rate": 88610},
          "ভিটা": {"rate": 177766},
          "বাগান": {"rate": 177632},
          "পুকুর": {"rate": 124166},
          "ডোবা": {"rate": 71304}
        }
      },
      "খোর্দ কেঁওচিয়া": {
        "rates": {
          "নাল": {"rate": 49331},
          "ভিটা": {"rate": 71370},
          "বাগান": {"rate": 21805},
          "পুকুর": {"rate": 67473}
        }
      },
      "গারাঙ্গীয়া": {
        "rates": {
          "নাল": {"rate": 71458},
          "ভিটা": {"rate": 136177},
          "বাগান": {"rate": 130589},
          "পুকুর": {"rate": 70374},
          "ডোবা": {"rate": 92858}
        }
      },
      "গরিবারঝিল": {
        "rates": {
          "নাল": {"rate": 51957},
          "ভিটা": {"rate": 97333, "p": true},
          "পুকুর": {"rate": 67077}
        }
      },
      "ঘিলাতলী": {
        "rates": {
          "নাল": {"rate": 27495},
          "ভিটা": {"rate": 28000, "p": true},
          "পুকুর": {"rate": 11740, "p": true}
        }
      },
      "চর উত্তর বামনডেঙ্গা": {
        "rates": {
          "নাল": {"rate": 12083, "p": true},
          "ভিটা": {"rate": 1650, "p": true}
        }
      },
      "চরখাগরিয়া": {
        "rates": {
          "নাল": {"rate": 89413},
          "ভিটা": {"rate": 151976},
          "বাগান": {"rate": 42913, "p": true},
          "পুকুর": {"rate": 101906}
        }
      },
      "চরতী": {
        "rates": {
          "নাল": {"rate": 34541},
          "ভিটা": {"rate": 106501},
          "বাগান": {"rate": 140783},
          "পুকুর": {"rate": 67593},
          "ডোবা": {"rate": 8333, "p": true}
        }
      },
      "চিকবাড়ী": {
        "rates": {
          "নাল": {"rate": 66135},
          "ভিটা": {"rate": 106095},
          "পুকুর": {"rate": 59549}
        }
      },
      "চূড়ামণি": {
        "rates": {
          "নাল": {"rate": 35163},
          "ভিটা": {"rate": 103455},
          "বাগান": {"rate": 66417, "p": true},
          "পুকুর": {"rate": 94798}
        }
      },
      "ছদাহা": {
        "rates": {
          "নাল": {"rate": 183186},
          "ভিটা": {"rate": 188150},
          "বাগান": {"rate": 140511},
          "পুকুর": {"rate": 111028},
          "ডোবা": {"rate": 1589}
        }
      },
      "ছোট ঢেমশা": {
        "rates": {
          "নাল": {"rate": 120870},
          "ভিটা": {"rate": 138342},
          "বাগান": {"rate": 108642, "p": true},
          "পুকুর": {"rate": 116635}
        }
      },
      "ছোট হাতিয়া": {
        "rates": {
          "নাল": {"rate": 115009},
          "ভিটা": {"rate": 115294},
          "বাগান": {"rate": 77895, "p": true},
          "পুকুর": {"rate": 162808}
        }
      },
      "ছৈয়দাবাদ": {
        "rates": {
          "নাল": {"rate": 73756},
          "ভিটা": {"rate": 105473},
          "বাগান": {"rate": 100000, "p": true},
          "পুকুর": {"rate": 62081}
        }
      },
      "ছৈয়দাবাদ পৌর এলাকা": {
        "rates": {
          "নাল": {"rate": 38490},
          "ভিটা": {"rate": 40384, "p": true}
        }
      },
      "জঙ্গল মাদার্শা": {
        "rates": {
          "নাল": {"rate": 21429},
          "ভিটা": {"rate": 2464, "p": true},
          "পুকুর": {"rate": 1300, "p": true}
        }
      },
      "জনার কেঁওচিয়া": {
        "rates": {
          "নাল": {"rate": 360596},
          "ভিটা": {"rate": 293670},
          "বাগান": {"rate": 273190},
          "পুকুর": {"rate": 148460},
          "ডোবা": {"rate": 163158, "p": true}
        }
      },
      "ডলু": {
        "rates": {
          "নাল": {"rate": 87462},
          "ভিটা": {"rate": 198363},
          "বাগান": {"rate": 57259},
          "পুকুর": {"rate": 106997}
        }
      },
      "তালগাঁও": {
        "rates": {
          "নাল": {"rate": 107095},
          "ভিটা": {"rate": 284733},
          "বাগান": {"rate": 83987},
          "পুকুর": {"rate": 44525},
          "ডোবা": {"rate": 3000, "p": true}
        }
      },
      "তুলাতলী": {
        "rates": {
          "নাল": {"rate": 55178},
          "ভিটা": {"rate": 101338},
          "বাগান": {"rate": 124000},
          "পুকুর": {"rate": 109354}
        }
      },
      "তেমুহানি": {
        "rates": {
          "নাল": {"rate": 89439},
          "ভিটা": {"rate": 84000},
          "পুকুর": {"rate": 109625}
        }
      },
      "দক্ষিণ কেওচিয়া": {
        "rates": {
          "নাল": {"rate": 58244},
          "ভিটা": {"rate": 92643},
          "বাগান": {"rate": 180000},
          "পুকুর": {"rate": 112308}
        }
      },
      "দক্ষিণ ঢেমশা": {
        "rates": {
          "নাল": {"rate": 170814},
          "ভিটা": {"rate": 239196},
          "বাগান": {"rate": 106350},
          "পুকুর": {"rate": 99128},
          "ডোবা": {"rate": 31035}
        }
      },
      "দক্ষিণ ঢেমশা পৌরএলাকা": {
        "rates": {
          "নাল": {"rate": 119574},
          "ভিটা": {"rate": 153098},
          "বাগান": {"rate": 52846},
          "পুকুর": {"rate": 208808},
          "ডোবা": {"rate": 560000}
        }
      },
      "দক্ষিণ বামনডেঙ্গা": {
        "rates": {
          "নাল": {"rate": 38582},
          "ভিটা": {"rate": 346779},
          "পুকুর": {"rate": 143600, "p": true}
        }
      },
      "দূরদূরী": {
        "rates": {
          "নাল": {"rate": 69878},
          "ভিটা": {"rate": 75830},
          "বাগান": {"rate": 81505},
          "পুকুর": {"rate": 86163},
          "ডোবা": {"rate": 44445}
        }
      },
      "ধর্মপুর": {
        "rates": {
          "নাল": {"rate": 53089},
          "ভিটা": {"rate": 111557},
          "বাগান": {"rate": 73314},
          "পুকুর": {"rate": 62798}
        }
      },
      "নলুয়া": {
        "rates": {
          "নাল": {"rate": 64975},
          "ভিটা": {"rate": 94693},
          "বাগান": {"rate": 48485, "p": true},
          "পুকুর": {"rate": 78113},
          "ডোবা": {"rate": 80000}
        }
      },
      "নয়াপাড়া": {
        "rates": {
          "নাল": {"rate": 119092},
          "ভিটা": {"rate": 124204},
          "বাগান": {"rate": 124026},
          "পুকুর": {"rate": 112164},
          "ডোবা": {"rate": 151095}
        }
      },
      "পশ্চিম গাটিয়াডেঙ্গা": {
        "rates": {
          "নাল": {"rate": 59887},
          "ভিটা": {"rate": 91414},
          "বাগান": {"rate": 68889, "p": true},
          "পুকুর": {"rate": 80695}
        }
      },
      "পশ্চিম ঢেমশা": {
        "rates": {
          "নাল": {"rate": 325160},
          "ভিটা": {"rate": 412500, "p": true},
          "পুকুর": {"rate": 76000, "p": true}
        }
      },
      "পঃ ঢেমশা পৌরএলাকা": {
        "rates": {
          "নাল": {"rate": 268448},
          "ভিটা": {"rate": 442648},
          "বাগান": {"rate": 198516},
          "পুকুর": {"rate": 135077}
        }
      },
      "পুরানগড়": {
        "rates": {
          "নাল": {"rate": 40148},
          "ভিটা": {"rate": 92511},
          "বাগান": {"rate": 58029},
          "পুকুর": {"rate": 82523},
          "ডোবা": {"rate": 18000, "p": true}
        }
      },
      "পূর্ব গাটিয়াডেঙ্গা": {
        "rates": {
          "নাল": {"rate": 40135},
          "ভিটা": {"rate": 202377},
          "বাগান": {"rate": 316447},
          "পুকুর": {"rate": 156163}
        }
      },
      "বড় দূয়ারা": {
        "rates": {
          "নাল": {"rate": 93407},
          "ভিটা": {"rate": 93285},
          "পুকুর": {"rate": 80770},
          "ডোবা": {"rate": 20325, "p": true}
        }
      },
      "বাজালিয়া": {
        "rates": {
          "নাল": {"rate": 115184},
          "ভিটা": {"rate": 283883},
          "বাগান": {"rate": 296167},
          "পুকুর": {"rate": 258087},
          "ডোবা": {"rate": 133333, "p": true}
        }
      },
      "বাবুনগর": {
        "rates": {
          "নাল": {"rate": 160402},
          "ভিটা": {"rate": 120373},
          "বাগান": {"rate": 171429},
          "পুকুর": {"rate": 150598}
        }
      },
      "বারদোনা": {
        "rates": {
          "নাল": {"rate": 98525},
          "ভিটা": {"rate": 156024},
          "বাগান": {"rate": 125127},
          "পুকুর": {"rate": 153488}
        }
      },
      "বৈতরণী": {
        "rates": {
          "নাল": {"rate": 36944},
          "ভিটা": {"rate": 37038},
          "বাগান": {"rate": 53846, "p": true},
          "পুকুর": {"rate": 38168}
        }
      },
      "মনিয়াবাদ": {
        "rates": {
          "নাল": {"rate": 85875},
          "ভিটা": {"rate": 298450},
          "পুকুর": {"rate": 151136}
        }
      },
      "মরফলা": {
        "rates": {
          "নাল": {"rate": 83945},
          "ভিটা": {"rate": 102311},
          "বাগান": {"rate": 158000, "p": true},
          "পুকুর": {"rate": 175125}
        }
      },
      "মলয়াবাদ": {
        "rates": {
          "নাল": {"rate": 145452},
          "ভিটা": {"rate": 171253},
          "বাগান": {"rate": 100000, "p": true},
          "পুকুর": {"rate": 50000, "p": true}
        }
      },
      "মাইসপাড়া": {
        "rates": {
          "নাল": {"rate": 64338},
          "ভিটা": {"rate": 125000},
          "পুকুর": {"rate": 90141}
        }
      },
      "মাদার্শা": {
        "rates": {
          "নাল": {"rate": 106213},
          "ভিটা": {"rate": 101619},
          "বাগান": {"rate": 252486},
          "পুকুর": {"rate": 100012}
        }
      },
      "মাহালিয়া": {
        "rates": {
          "নাল": {"rate": 48344},
          "ভিটা": {"rate": 78042},
          "পুকুর": {"rate": 68000},
          "ডোবা": {"rate": 294118, "p": true}
        }
      },
      "মৈশামূড়া": {
        "rates": {
          "নাল": {"rate": 77925},
          "ভিটা": {"rate": 223704},
          "বাগান": {"rate": 229000},
          "পুকুর": {"rate": 96535},
          "ডোবা": {"rate": 25000, "p": true}
        }
      },
      "মোহাম্মদ খালী": {
        "rates": {
          "নাল": {"rate": 58545},
          "ভিটা": {"rate": 245788},
          "বাগান": {"rate": 500000},
          "পুকুর": {"rate": 87122}
        }
      },
      "রসুলাবাদ": {
        "rates": {
          "নাল": {"rate": 280414},
          "ভিটা": {"rate": 410732},
          "বাগান": {"rate": 100000, "p": true},
          "পুকুর": {"rate": 203950}
        }
      },
      "রামপুর": {
        "rates": {
          "নাল": {"rate": 115125},
          "ভিটা": {"rate": 109559},
          "বাগান": {"rate": 126667},
          "পুকুর": {"rate": 52103}
        }
      },
      "রামপুর পৌরএলাকা": {
        "rates": {
          "নাল": {"rate": 205685},
          "ভিটা": {"rate": 438627},
          "বাগান": {"rate": 121167},
          "পুকুর": {"rate": 268095}
        }
      },
      "রূপকানিয়া": {
        "rates": {
          "নাল": {"rate": 66125},
          "ভিটা": {"rate": 107115},
          "বাগান": {"rate": 85882, "p": true},
          "পুকুর": {"rate": 98919},
          "ডোবা": {"rate": 100000}
        }
      },
      "রূপকানিয়া পৌরএলাকা": {
        "rates": {
          "নাল": {"rate": 392913},
          "ভিটা": {"rate": 426666},
          "বাগান": {"rate": 560799},
          "পুকুর": {"rate": 206545},
          "ডোবা": {"rate": 631578}
        }
      },
      "রূপনগর": {
        "rates": {
          "নাল": {"rate": 33600},
          "ভিটা": {"rate": 8212},
          "বাগান": {"rate": 124283, "p": true},
          "পুকুর": {"rate": 115854, "p": true}
        }
      },
      "শীলঘাটা": {
        "rates": {
          "নাল": {"rate": 26661},
          "ভিটা": {"rate": 54523},
          "বাগান": {"rate": 147059, "p": true},
          "পুকুর": {"rate": 70000, "p": true}
        }
      },
      "সাইরতলী": {
        "rates": {
          "নাল": {"rate": 79563},
          "ভিটা": {"rate": 125000, "p": true},
          "বাগান": {"rate": 42533, "p": true},
          "পুকুর": {"rate": 60000}
        }
      },
      "সারশিয়া": {
        "rates": {
          "নাল": {"rate": 30215},
          "ভিটা": {"rate": 38367, "p": true},
          "পুকুর": {"rate": 15333, "p": true}
        }
      },
      "সুইপুরা": {
        "rates": {
          "নাল": {"rate": 70253},
          "ভিটা": {"rate": 147926},
          "বাগান": {"rate": 87426},
          "পুকুর": {"rate": 108822}
        }
      },
      "সোনাকানিয়া": {
        "rates": {
          "নাল": {"rate": 152958},
          "ভিটা": {"rate": 216120},
          "বাগান": {"rate": 43748, "p": true},
          "পুকুর": {"rate": 147539}
        }
      },
      "সোনাকানিয়া পৌরএলাকা": {
        "rates": {
          "নাল": {"rate": 151585},
          "ভিটা": {"rate": 355640},
          "বাগান": {"rate": 182955},
          "পুকুর": {"rate": 138822}
        }
      },
      "হিলমিলি": {
        "rates": {
          "নাল": {"rate": 96482},
          "ভিটা": {"rate": 175343},
          "বাগান": {"rate": 108164},
          "পুকুর": {"rate": 100000}
        }
      },
      "হোছননগর": {
        "rates": {
          "নাল": {"rate": 106330},
          "ভিটা": {"rate": 240360},
          "বাগান": {"rate": 50000},
          "পুকুর": {"rate": 93050},
          "ডোবা": {"rate": 50000, "p": true}
        }
      }
    }
  },
  sitakunda: {
    "name": "সীতাকুণ্ড",
    "period": "2025-2026",
    "mouzas": {
      "আমিনাবাদ (পৌর)": {
        "rates": {
          "নাল": {"rate": 273037},
          "ভিটা": {"rate": 616453},
          "বাগান": {"rate": 241867},
          "পুকুর": {"rate": 248077},
          "ডোবা": {"rate": 73225}
        }
      },
      "আশাকুরিপুর": {
        "rates": {
          "নাল": {"rate": 45321},
          "ভিটা": {"rate": 139119},
          "বাগান": {"rate": 82361},
          "পুকুর": {"rate": 84571},
          "ডোবা": {"rate": 20000}
        }
      },
      "উত্তর হালিমপুর": {
        "rates": {
          "নাল": {"rate": 314321},
          "ভিটা": {"rate": 592782},
          "বাগান": {"rate": 245368},
          "পুকুর": {"rate": 455358},
          "ডোবা": {"rate": 50960}
        }
      },
      "উত্তর সোনাইছড়ি": {
        "rates": {
          "নাল": {"rate": 141648},
          "ভিটা": {"rate": 348586},
          "বাগান": {"rate": 229226},
          "পুকুর": {"rate": 181763},
          "ডোবা": {"rate": 27112}
        }
      },
      "উত্তর জঙ্গল সোনাইছড়ি": {
        "rates": {
          "নাল": {"rate": 25421},
          "ভিটা": {"rate": 36761},
          "পুকুর": {"rate": 11178},
          "ডোবা": {"rate": 18333}
        }
      },
      "উত্তর টেরিয়াইল": {
        "rates": {
          "নাল": {"rate": 96214},
          "ভিটা": {"rate": 222838},
          "বাগান": {"rate": 80972},
          "পুকুর": {"rate": 77227},
          "ডোবা": {"rate": 6887}
        }
      },
      "উত্তর রহমতনগর": {
        "rates": {
          "নাল": {"rate": 25798},
          "ভিটা": {"rate": 30100},
          "পুকুর": {"rate": 15164},
          "ডোবা": {"rate": 13200}
        }
      },
      "এয়াকুবনগর (পৌর)": {
        "rates": {
          "নাল": {"rate": 139336},
          "ভিটা": {"rate": 164445},
          "বাগান": {"rate": 158000},
          "পুকুর": {"rate": 75179},
          "ডোবা": {"rate": 22612}
        }
      },
      "কেশবপুর": {
        "rates": {
          "নাল": {"rate": 256874},
          "ভিটা": {"rate": 369500},
          "বাগান": {"rate": 318571},
          "পুকুর": {"rate": 240774},
          "ডোবা": {"rate": 23521}
        }
      },
      "কাটগড়": {
        "rates": {
          "নাল": {"rate": 123466},
          "ভিটা": {"rate": 201248},
          "বাগান": {"rate": 118105},
          "পুকুর": {"rate": 91524},
          "ডোবা": {"rate": 19200}
        }
      },
      "কৃষ্ণপুর": {
        "rates": {
          "নাল": {"rate": 61568},
          "ভিটা": {"rate": 42524},
          "বাগান": {"rate": 14886},
          "পুকুর": {"rate": 59486},
          "ডোবা": {"rate": 16000}
        }
      },
      "কল্লাবাড়িয়া": {
        "rates": {
          "নাল": {"rate": 84397},
          "ভিটা": {"rate": 507140},
          "বাগান": {"rate": 39140},
          "পুকুর": {"rate": 123487},
          "ডোবা": {"rate": 14000}
        }
      },
      "কেদারখীল": {
        "rates": {
          "নাল": {"rate": 45728},
          "ভিটা": {"rate": 136445},
          "পুকুর": {"rate": 50803},
          "ডোবা": {"rate": 17402}
        }
      },
      "খাদিমপাড়া": {
        "rates": {
          "নাল": {"rate": 349513},
          "ভিটা": {"rate": 522784},
          "বাগান": {"rate": 300000},
          "পুকুর": {"rate": 400000},
          "ডোবা": {"rate": 50116}
        }
      },
      "ভলিয়াখালী": {
        "rates": {
          "নাল": {"rate": 40060},
          "ভিটা": {"rate": 63913},
          "পুকুর": {"rate": 13713},
          "ডোবা": {"rate": 13334}
        }
      },
      "গোয়াখালী": {
        "rates": {
          "নাল": {"rate": 40189},
          "ভিটা": {"rate": 58886},
          "বাগান": {"rate": 57947},
          "পুকুর": {"rate": 109303},
          "ডোবা": {"rate": 17020}
        }
      },
      "সোনাবাড়িয়া": {
        "rates": {
          "নাল": {"rate": 47361},
          "ভিটা": {"rate": 225481},
          "পুকুর": {"rate": 104619},
          "ডোবা": {"rate": 10263}
        }
      },
      "চর বাঁশবাড়িয়া": {
        "rates": {
          "নাল": {"rate": 44374},
          "ভিটা": {"rate": 42248},
          "পুকুর": {"rate": 25445},
          "ডোবা": {"rate": 13617}
        }
      },
      "ছোট কুমিরা": {
        "rates": {
          "নাল": {"rate": 41328},
          "ভিটা": {"rate": 50000},
          "পুকুর": {"rate": 25041},
          "ডোবা": {"rate": 10753}
        }
      },
      "জঙ্গল হালিমপুর": {
        "rates": {
          "নাল": {"rate": 194255},
          "ভিটা": {"rate": 466080},
          "বাগান": {"rate": 20010},
          "পুকুর": {"rate": 17000},
          "ডোবা": {"rate": 20000}
        }
      },
      "জঙ্গল লতিফপুর": {
        "rates": {
          "নাল": {"rate": 211265},
          "ভিটা": {"rate": 415363},
          "বাগান": {"rate": 192000},
          "পুকুর": {"rate": 86750},
          "ডোবা": {"rate": 13500}
        }
      },
      "জঙ্গল অতিয়ারী": {
        "rates": {
          "নাল": {"rate": 76099},
          "ভিটা": {"rate": 577500},
          "বাগান": {"rate": 75871},
          "পুকুর": {"rate": 86260},
          "ডোবা": {"rate": 10000}
        }
      },
      "জঙ্গল সোনাইছড়ি": {
        "rates": {
          "নাল": {"rate": 4200},
          "ভিটা": {"rate": 5200},
          "পুকুর": {"rate": 22008},
          "ডোবা": {"rate": 1700}
        }
      },
      "ছায়ানাবাদ": {
        "rates": {
          "নাল": {"rate": 248332},
          "ভিটা": {"rate": 647523},
          "বাগান": {"rate": 270628},
          "পুকুর": {"rate": 729748},
          "ডোবা": {"rate": 25000}
        }
      },
      "জঙ্গল বাঁশবাড়িয়া": {
        "rates": {
          "নাল": {"rate": 30230},
          "ভিটা": {"rate": 29093},
          "বাগান": {"rate": 22229},
          "পুকুর": {"rate": 140697},
          "ডোবা": {"rate": 5400}
        }
      },
      "জঙ্গল কাটগড়": {
        "rates": {
          "নাল": {"rate": 15001},
          "ভিটা": {"rate": 23600},
          "বাগান": {"rate": 404298},
          "পুকুর": {"rate": 10300},
          "ডোবা": {"rate": 9293}
        }
      },
      "জাফরনগর": {
        "rates": {
          "নাল": {"rate": 83534},
          "ভিটা": {"rate": 142843},
          "বাগান": {"rate": 23644},
          "পুকুর": {"rate": 17863},
          "ডোবা": {"rate": 16666}
        }
      },
      "জঙ্গল সীতাকুণ্ড (পৌর)": {
        "rates": {
          "নাল": {"rate": 58100},
          "ভিটা": {"rate": 89600},
          "বাগান": {"rate": 29746},
          "পুকুর": {"rate": 44000},
          "ডোবা": {"rate": 14620}
        }
      },
      "জঙ্গল মধ্যনগর (পৌর)": {
        "rates": {
          "বাগান": {"rate": 41280},
          "পুকুর": {"rate": 14560},
          "ডোবা": {"rate": 14560}
        }
      },
      "ছুয়াতলী": {
        "rates": {
          "নাল": {"rate": 321835},
          "ভিটা": {"rate": 368000},
          "পুকুর": {"rate": 351573},
          "ডোবা": {"rate": 32500}
        }
      },
      "দক্ষিণ হালিমপুর": {
        "rates": {
          "নাল": {"rate": 344813},
          "ভিটা": {"rate": 499269},
          "বাগান": {"rate": 169586},
          "পুকুর": {"rate": 358469},
          "ডোবা": {"rate": 246540}
        }
      },
      "দক্ষিণ সোনাইছড়ি": {
        "rates": {
          "নাল": {"rate": 370850},
          "ভিটা": {"rate": 268701},
          "বাগান": {"rate": 153453},
          "পুকুর": {"rate": 278608},
          "ডোবা": {"rate": 223518}
        }
      },
      "দক্ষিণ জঙ্গল সোনাইছড়ি": {
        "rates": {
          "নাল": {"rate": 225864},
          "ভিটা": {"rate": 307834},
          "পুকুর": {"rate": 64286},
          "ডোবা": {"rate": 18111}
        }
      },
      "দক্ষিণ রহমতনগর": {
        "rates": {
          "নাল": {"rate": 13100},
          "ভিটা": {"rate": 23100},
          "পুকুর": {"rate": 21600},
          "ডোবা": {"rate": 11300}
        }
      },
      "দক্ষিণ টেরিয়াইল (আংশে পৌর)": {
        "rates": {
          "নাল": {"rate": 86359},
          "ভিটা": {"rate": 156711},
          "বাগান": {"rate": 85131},
          "পুকুর": {"rate": 69118},
          "ডোবা": {"rate": 100000}
        }
      },
      "ধর্মপুর": {
        "rates": {
          "নাল": {"rate": 108642},
          "ভিটা": {"rate": 255119},
          "বাগান": {"rate": 35000},
          "পুকুর": {"rate": 89000},
          "ডোবা": {"rate": 16242}
        }
      },
      "নলদীঘি": {
        "rates": {
          "নাল": {"rate": 118768},
          "ভিটা": {"rate": 103105},
          "বাগান": {"rate": 127481},
          "পুকুর": {"rate": 59520},
          "ডোবা": {"rate": 21778}
        }
      },
      "লতিফপুর (ক্রম ৩৮)": {
        "rates": {
          "নাল": {"rate": 30748},
          "ভিটা": {"rate": 37025},
          "বাগান": {"rate": 51283},
          "পুকুর": {"rate": 20000},
          "ডোবা": {"rate": 8364}
        }
      },
      "লতিফপুর (ক্রম ৫৫)": {
        "rates": {
          "নাল": {"rate": 454407},
          "ভিটা": {"rate": 478758},
          "বাগান": {"rate": 475000},
          "পুকুর": {"rate": 256386},
          "ডোবা": {"rate": 200000}
        }
      },
      "ফরাদপুর": {
        "rates": {
          "নাল": {"rate": 140999},
          "ভিটা": {"rate": 122286},
          "পুকুর": {"rate": 466293},
          "ডোবা": {"rate": 12187}
        }
      },
      "বড় কুমিরা": {
        "rates": {
          "নাল": {"rate": 422400},
          "ভিটা": {"rate": 488340},
          "বাগান": {"rate": 352251},
          "পুকুর": {"rate": 456274},
          "ডোবা": {"rate": 18827}
        }
      },
      "বাঁশবাড়িয়া": {
        "rates": {
          "নাল": {"rate": 141303},
          "ভিটা": {"rate": 183989},
          "বাগান": {"rate": 50000},
          "পুকুর": {"rate": 122033},
          "ডোবা": {"rate": 14250}
        }
      },
      "বোয়ালিয়া": {
        "rates": {
          "নাল": {"rate": 45233},
          "ভিটা": {"rate": 247681},
          "পুকুর": {"rate": 285921},
          "ডোবা": {"rate": 14286}
        }
      },
      "বাগাচতর": {
        "rates": {
          "নাল": {"rate": 34720},
          "ভিটা": {"rate": 44659},
          "বাগান": {"rate": 16207},
          "পুকুর": {"rate": 42488},
          "ডোবা": {"rate": 14785}
        }
      },
      "বাকখালী": {
        "rates": {
          "নাল": {"rate": 46961},
          "ভিটা": {"rate": 46351},
          "পুকুর": {"rate": 18047},
          "ডোবা": {"rate": 11392}
        }
      },
      "বরমপুর": {
        "rates": {
          "নাল": {"rate": 44366},
          "ভিটা": {"rate": 80247},
          "পুকুর": {"rate": 40531},
          "ডোবা": {"rate": 7783}
        }
      },
      "ভাটিয়ারী": {
        "rates": {
          "নাল": {"rate": 370604},
          "ভিটা": {"rate": 769700},
          "বাগান": {"rate": 306131},
          "পুকুর": {"rate": 471592},
          "ডোবা": {"rate": 335429}
        }
      },
      "ভাটেরখীল": {
        "rates": {
          "নাল": {"rate": 52101},
          "ভিটা": {"rate": 68110},
          "বাগান": {"rate": 42395},
          "পুকুর": {"rate": 44719},
          "ডোবা": {"rate": 15012}
        }
      },
      "মধ্য সোনাইছড়ি": {
        "rates": {
          "নাল": {"rate": 244242},
          "ভিটা": {"rate": 609622},
          "বাগান": {"rate": 150000},
          "পুকুর": {"rate": 289485},
          "ডোবা": {"rate": 122500}
        }
      },
      "মহিষভাঙ্গা": {
        "rates": {
          "নাল": {"rate": 144502},
          "ভিটা": {"rate": 259137},
          "বাগান": {"rate": 239421},
          "পুকুর": {"rate": 159325},
          "ডোবা": {"rate": 20336}
        }
      },
      "মালনীটোলা": {
        "rates": {
          "নাল": {"rate": 106704},
          "ভিটা": {"rate": 196619},
          "বাগান": {"rate": 86827},
          "পুকুর": {"rate": 55816},
          "ডোবা": {"rate": 9337}
        }
      },
      "বক্সন নগর": {
        "rates": {
          "নাল": {"rate": 58456},
          "ভিটা": {"rate": 35577},
          "পুকুর": {"rate": 28924},
          "ডোবা": {"rate": 10500}
        }
      },
      "মুরাদপুর": {
        "rates": {
          "নাল": {"rate": 138070},
          "ভিটা": {"rate": 246244},
          "বাগান": {"rate": 40254},
          "পুকুর": {"rate": 144600},
          "ডোবা": {"rate": 35000}
        }
      },
      "মধ্যনগর (পৌর)": {
        "rates": {
          "নাল": {"rate": 222269},
          "ভিটা": {"rate": 870168},
          "বাগান": {"rate": 224991},
          "পুকুর": {"rate": 452859},
          "ডোবা": {"rate": 117801}
        }
      },
      "নবাবগঞ্জ": {
        "rates": {
          "নাল": {"rate": 46223},
          "ভিটা": {"rate": 64330},
          "বাগান": {"rate": 21265},
          "পুকুর": {"rate": 17942},
          "ডোবা": {"rate": 10886}
        }
      },
      "লট ৬৬ সোনাইছড়ি": {
        "rates": {
          "নাল": {"rate": 16926},
          "ভিটা": {"rate": 33867},
          "পুকুর": {"rate": 2657},
          "ডোবা": {"rate": 5134}
        }
      },
      "লট ৬৮ কেশবপুর": {
        "rates": {
          "নাল": {"rate": 6036},
          "ভিটা": {"rate": 10760},
          "পুকুর": {"rate": 2100},
          "ডোবা": {"rate": 4760}
        }
      },
      "লট ৮ কুমিরা": {
        "rates": {
          "নাল": {"rate": 5596},
          "ভিটা": {"rate": 37282},
          "পুকুর": {"rate": 1000},
          "ডোবা": {"rate": 3117}
        }
      },
      "লট ২ ছোট কুমিরা": {
        "rates": {
          "নাল": {"rate": 51250},
          "ভিটা": {"rate": 14953},
          "পুকুর": {"rate": 3566},
          "ডোবা": {"rate": 1380}
        }
      },
      "লালানগর": {
        "rates": {
          "নাল": {"rate": 5811},
          "ভিটা": {"rate": 24075},
          "বাগান": {"rate": 25151},
          "পুকুর": {"rate": 24533},
          "ডোবা": {"rate": 2200}
        }
      },
      "লট ৮২ লবণাক্ষ": {
        "rates": {
          "নাল": {"rate": 2300}
        }
      },
      "শীতলপুর": {
        "rates": {
          "নাল": {"rate": 246070},
          "ভিটা": {"rate": 380009},
          "বাগান": {"rate": 378077},
          "পুকুর": {"rate": 243492},
          "ডোবা": {"rate": 75136}
        }
      },
      "সাহামামুদপুর": {
        "rates": {
          "নাল": {"rate": 211500},
          "ভিটা": {"rate": 67923},
          "পুকুর": {"rate": 67620},
          "ডোবা": {"rate": 14667}
        }
      },
      "শিবপুর (পৌর)": {
        "rates": {
          "নাল": {"rate": 120690},
          "ভিটা": {"rate": 323441},
          "বাগান": {"rate": 220000},
          "পুকুর": {"rate": 113004},
          "ডোবা": {"rate": 68253}
        }
      },
      "সৈয়দপুর": {
        "rates": {
          "নাল": {"rate": 40227},
          "ভিটা": {"rate": 109457},
          "বাগান": {"rate": 161048},
          "পুকুর": {"rate": 46598},
          "ডোবা": {"rate": 13438}
        }
      },
      "সীতাকুণ্ড (পৌর)": {
        "rates": {
          "নাল": {"rate": 214481},
          "ভিটা": {"rate": 591213},
          "বাগান": {"rate": 240236},
          "পুকুর": {"rate": 296213},
          "ডোবা": {"rate": 48367}
        }
      },
      "জঙ্গল টেরিয়াইল": {
        "rates": {
          "বাগান": {"rate": 21465}
        }
      }
    }
  },
  patiya: {
    "name": "পটিয়া",
    "period": "2025-2026",
    "mouzas": {
      "আশিয়া": {
        "rates": {
          "নাল": {"rate": 58786},
          "বাড়ী": {"rate": 161768},
          "ভিটা": {"rate": 80907},
          "বাগান": {"rate": 58721},
          "পুকুর": {"rate": 88172},
          "ডোবা": {"rate": 42017}
        },
        "jl": "109"
      },
      "আজিমপুর": {
        "rates": {
          "নাল": {"rate": 172007},
          "বাড়ী": {"rate": 161969},
          "ভিটা": {"rate": 110000},
          "বাগান": {"rate": 26947},
          "পুকুর": {"rate": 173469},
          "ডোবা": {"rate": 18900}
        },
        "jl": "114"
      },
      "আলামপুর": {
        "rates": {
          "নাল": {"rate": 59473},
          "বাড়ী": {"rate": 30715},
          "ভিটা": {"rate": 77083},
          "বাগান": {"rate": 200000},
          "পুকুর": {"rate": 56309},
          "ডোবা": {"rate": 15384}
        },
        "jl": "69"
      },
      "আশাতা": {
        "rates": {
          "নাল": {"rate": 50444},
          "বাড়ী": {"rate": 193929},
          "ভিটা": {"rate": 15000},
          "বাগান": {"rate": 1650},
          "পুকুর": {"rate": 20313},
          "ডোবা": {"rate": 3125}
        },
        "jl": "122"
      },
      "ঈশ্বরখাইন": {
        "rates": {
          "নাল": {"rate": 41691},
          "বাড়ী": {"rate": 69373},
          "ভিটা": {"rate": 4126},
          "বাগান": {"rate": 50360},
          "পুকুর": {"rate": 56161},
          "ডোবা": {"rate": 14074}
        },
        "jl": "70"
      },
      "উত্তর জঙ্গল খীমাই": {
        "rates": {
          "নাল": {"rate": 11452},
          "বাড়ী": {"rate": 1300},
          "ভিটা": {"rate": 1300},
          "বাগান": {"rate": 11447},
          "পুকুর": {"rate": 1300},
          "ডোবা": {"rate": 1300}
        },
        "jl": "84"
      },
      "উত্তর দেয়াং": {
        "rates": {
          "নাল": {"rate": 137984},
          "বাড়ী": {"rate": 136529},
          "ভিটা": {"rate": 136603},
          "বাগান": {"rate": 17750},
          "পুকুর": {"rate": 107413},
          "ডোবা": {"rate": 105842}
        },
        "jl": "30"
      },
      "উত্তর ভূর্ষি": {
        "rates": {
          "নাল": {"rate": 42324},
          "বাড়ী": {"rate": 82700},
          "ভিটা": {"rate": 50427},
          "বাগান": {"rate": 1950},
          "পুকুর": {"rate": 83750},
          "ডোবা": {"rate": 3282}
        },
        "jl": "75"
      },
      "উত্তর সমুরা": {
        "rates": {
          "নাল": {"rate": 31080},
          "বাড়ী": {"rate": 38645},
          "ভিটা": {"rate": 41000},
          "বাগান": {"rate": 50667},
          "পুকুর": {"rate": 38247},
          "ডোবা": {"rate": 3042}
        },
        "jl": "72"
      },
      "উজিরপুর": {
        "rates": {
          "নাল": {"rate": 153061},
          "বাড়ী": {"rate": 69265},
          "ভিটা": {"rate": 222667},
          "বাগান": {"rate": 34616},
          "পুকুর": {"rate": 132322},
          "ডোবা": {"rate": 11519}
        },
        "jl": "48"
      },
      "উনাইনপুরা": {
        "rates": {
          "নাল": {"rate": 209106},
          "বাড়ী": {"rate": 80810},
          "ভিটা": {"rate": 87197},
          "বাগান": {"rate": 1951},
          "পুকুর": {"rate": 50223},
          "ডোবা": {"rate": 4493}
        },
        "jl": "127"
      },
      "এয়ারবদ্ভী": {
        "rates": {
          "নাল": {"rate": 182966},
          "বাড়ী": {"rate": 110121},
          "ভিটা": {"rate": 33334},
          "বাগান": {"rate": 63492},
          "পুকুর": {"rate": 42699},
          "ডোবা": {"rate": 9651}
        },
        "jl": "45"
      },
      "ওকন্যারা": {
        "rates": {
          "নাল": {"rate": 56339},
          "বাড়ী": {"rate": 143738},
          "ভিটা": {"rate": 75000},
          "বাগান": {"rate": 4545},
          "পুকুর": {"rate": 73438},
          "ডোবা": {"rate": 15333}
        },
        "jl": "51"
      },
      "কচুখাইন": {
        "rates": {
          "নাল": {"rate": 184536},
          "বাড়ী": {"rate": 253730},
          "ভিটা": {"rate": 322915},
          "বাগান": {"rate": 76137},
          "পুকুর": {"rate": 153052},
          "ডোবা": {"rate": 45113}
        },
        "jl": "103"
      },
      "কঞ্চা": {
        "rates": {
          "নাল": {"rate": 116525},
          "বাড়ী": {"rate": 86077},
          "ভিটা": {"rate": 24909},
          "বাগান": {"rate": 6900},
          "পুকুর": {"rate": 201270},
          "ডোবা": {"rate": 10800}
        },
        "jl": "104"
      },
      "কমলছড়ি": {
        "rates": {
          "নাল": {"rate": 14730},
          "বাড়ী": {"rate": 1350},
          "ভিটা": {"rate": 17257},
          "বাগান": {"rate": 1596},
          "পুকুর": {"rate": 1657},
          "ডোবা": {"rate": 1357}
        },
        "jl": "92"
      },
      "কর্তলা": {
        "rates": {
          "নাল": {"rate": 73587},
          "বাড়ী": {"rate": 59091},
          "ভিটা": {"rate": 69245},
          "বাগান": {"rate": 20000},
          "পুকুর": {"rate": 50208},
          "ডোবা": {"rate": 16613}
        },
        "jl": "43"
      },
      "করনখাইন": {
        "rates": {
          "নাল": {"rate": 56866},
          "বাড়ী": {"rate": 84459},
          "ভিটা": {"rate": 65539},
          "বাগান": {"rate": 39957},
          "পুকুর": {"rate": 84124},
          "ডোবা": {"rate": 9532}
        },
        "jl": "62"
      },
      "করল": {
        "rates": {
          "নাল": {"rate": 68055},
          "বাড়ী": {"rate": 205715},
          "ভিটা": {"rate": 54317},
          "বাগান": {"rate": 28455},
          "পুকুর": {"rate": 105358},
          "ডোবা": {"rate": 18798}
        },
        "jl": "100"
      },
      "কালিয়াইশ": {
        "rates": {
          "নাল": {"rate": 47328},
          "বাড়ী": {"rate": 51154},
          "ভিটা": {"rate": 86000},
          "বাগান": {"rate": 20319},
          "পুকুর": {"rate": 27779},
          "ডোবা": {"rate": 3640}
        },
        "jl": "113"
      },
      "কাশিয়াইশ": {
        "rates": {
          "নাল": {"rate": 54598},
          "বাড়ী": {"rate": 140890},
          "ভিটা": {"rate": 59489},
          "বাগান": {"rate": 17752},
          "পুকুর": {"rate": 50691},
          "ডোবা": {"rate": 11148}
        },
        "jl": "23"
      },
      "কুমারগিরি": {
        "rates": {
          "নাল": {"rate": 29062},
          "বাড়ী": {"rate": 19478},
          "ভিটা": {"rate": 107908},
          "বাগান": {"rate": 3738},
          "পুকুর": {"rate": 60705},
          "ডোবা": {"rate": 9333}
        },
        "jl": "124"
      },
      "কুসুমপুরা": {
        "rates": {
          "নাল": {"rate": 188326},
          "বাড়ী": {"rate": 240159},
          "ভিটা": {"rate": 458016},
          "বাগান": {"rate": 28000},
          "পুকুর": {"rate": 101684},
          "ডোবা": {"rate": 68182}
        },
        "jl": "33"
      },
      "কৈছিপাড়া": {
        "rates": {
          "নাল": {"rate": 52505},
          "বাড়ী": {"rate": 182927},
          "ভিটা": {"rate": 14033},
          "বাগান": {"rate": 15625},
          "পুকুর": {"rate": 16735},
          "ডোবা": {"rate": 7500}
        },
        "jl": "78"
      },
      "কৈলশহর": {
        "rates": {
          "নাল": {"rate": 70275},
          "বাড়ী": {"rate": 129462},
          "ভিটা": {"rate": 124701},
          "বাগান": {"rate": 92072},
          "পুকুর": {"rate": 82981},
          "ডোবা": {"rate": 13924}
        },
        "jl": "77"
      },
      "কেশাগাঁও (JL 01)": {
        "rates": {
          "নাল": {"rate": 113599},
          "বাড়ী": {"rate": 111601},
          "ভিটা": {"rate": 200000},
          "বাগান": {"rate": 20000},
          "পুকুর": {"rate": 140067},
          "ডোবা": {"rate": 45000}
        },
        "jl": "01"
      },
      "কেশাগাঁও (JL 16)": {
        "rates": {
          "নাল": {"rate": 106622},
          "বাড়ী": {"rate": 98395},
          "ভিটা": {"rate": 102093},
          "বাগান": {"rate": 26120},
          "পুকুর": {"rate": 77095},
          "ডোবা": {"rate": 62500}
        },
        "jl": "16"
      },
      "কৈশ্যাম": {
        "rates": {
          "নাল": {"rate": 83110},
          "বাড়ী": {"rate": 143580},
          "ভিটা": {"rate": 105338},
          "বাগান": {"rate": 3825},
          "পুকুর": {"rate": 102118},
          "ডোবা": {"rate": 23125}
        },
        "jl": "18"
      },
      "খরনা": {
        "rates": {
          "নাল": {"rate": 86703},
          "বাড়ী": {"rate": 110051},
          "ভিটা": {"rate": 207091},
          "বাগান": {"rate": 46731},
          "পুকুর": {"rate": 79301},
          "ডোবা": {"rate": 15858}
        },
        "jl": "94"
      },
      "খানমোহনা": {
        "rates": {
          "নাল": {"rate": 71022},
          "বাড়ী": {"rate": 251731},
          "ভিটা": {"rate": 99933},
          "বাগান": {"rate": 13333},
          "পুকুর": {"rate": 171156},
          "ডোবা": {"rate": 7074}
        },
        "jl": "80"
      },
      "খোয়াজলী": {
        "rates": {
          "নাল": {"rate": 72569},
          "বাড়ী": {"rate": 121066},
          "ভিটা": {"rate": 85392},
          "বাগান": {"rate": 3614},
          "পুকুর": {"rate": 52876},
          "ডোবা": {"rate": 4456}
        },
        "jl": "106"
      },
      "গোরখাইন": {
        "rates": {
          "নাল": {"rate": 109849},
          "বাড়ী": {"rate": 179131},
          "ভিটা": {"rate": 144512},
          "বাগান": {"rate": 242353},
          "পুকুর": {"rate": 196207},
          "ডোবা": {"rate": 238236}
        },
        "jl": "38"
      },
      "গোড়লা": {
        "rates": {
          "নাল": {"rate": 71924},
          "বাড়ী": {"rate": 115969},
          "ভিটা": {"rate": 149520},
          "পুকুর": {"rate": 120323},
          "ডোবা": {"rate": 49177}
        },
        "jl": "59"
      },
      "চাটরা": {
        "rates": {
          "নাল": {"rate": 42652},
          "বাড়ী": {"rate": 129189},
          "ভিটা": {"rate": 213676},
          "বাগান": {"rate": 11765},
          "পুকুর": {"rate": 77726},
          "ডোবা": {"rate": 15105}
        },
        "jl": "107"
      },
      "চাপড়া": {
        "rates": {
          "নাল": {"rate": 124910},
          "বাড়ী": {"rate": 192133},
          "ভিটা": {"rate": 389704},
          "বাগান": {"rate": 319619},
          "পুকুর": {"rate": 138764},
          "ডোবা": {"rate": 19333}
        },
        "jl": "32"
      },
      "চাপড়ী": {
        "rates": {
          "নাল": {"rate": 118039},
          "বাড়ী": {"rate": 92008},
          "ভিটা": {"rate": 66667},
          "বাগান": {"rate": 13429},
          "পুকুর": {"rate": 118456},
          "ডোবা": {"rate": 7514}
        },
        "jl": "34"
      },
      "ছদর পেটুয়া": {
        "rates": {
          "নাল": {"rate": 19895},
          "বাড়ী": {"rate": 691365},
          "ভিটা": {"rate": 13333},
          "বাগান": {"rate": 1550},
          "পুকুর": {"rate": 64528},
          "ডোবা": {"rate": 3337950}
        },
        "jl": "76"
      },
      "১৫নং লট ছদর পেটুয়া": {
        "rates": {
          "নাল": {"rate": 20165},
          "ভিটা": {"rate": 36737},
          "পুকুর": {"rate": 50117}
        },
        "jl": "87"
      },
      "ছনহরা": {
        "rates": {
          "নাল": {"rate": 54107},
          "বাড়ী": {"rate": 96835},
          "ভিটা": {"rate": 97581},
          "বাগান": {"rate": 13333},
          "পুকুর": {"rate": 100475},
          "ডোবা": {"rate": 12500}
        },
        "jl": "108"
      },
      "জঙ্গলখাইন": {
        "rates": {
          "নাল": {"rate": 100238},
          "বাড়ী": {"rate": 141566},
          "ভিটা": {"rate": 185484},
          "বাগান": {"rate": 4560},
          "পুকুর": {"rate": 69923},
          "ডোবা": {"rate": 8000}
        },
        "jl": "53"
      },
      "জঙ্গলী জলপড়ি": {
        "rates": {
          "নাল": {"rate": 4400},
          "বাড়ী": {"rate": 1450},
          "ভিটা": {"rate": 1471},
          "বাগান": {"rate": 1200},
          "পুকুর": {"rate": 1200},
          "ডোবা": {"rate": 1200}
        },
        "jl": "88"
      },
      "জিরি": {
        "rates": {
          "নাল": {"rate": 105185},
          "বাড়ী": {"rate": 210880},
          "ভিটা": {"rate": 256471},
          "বাগান": {"rate": 12667},
          "পুকুর": {"rate": 131472},
          "ডোবা": {"rate": 112303}
        },
        "jl": "29"
      },
      "জোয়ারারাম খানা বাদ": {
        "rates": {
          "নাল": {"rate": 26963},
          "বাড়ী": {"rate": 28353},
          "ভিটা": {"rate": 3279},
          "বাগান": {"rate": 1750},
          "পুকুর": {"rate": 22667},
          "ডোবা": {"rate": 2539}
        },
        "jl": "119"
      },
      "ভেল্লাপাড়া": {
        "rates": {
          "নাল": {"rate": 41123},
          "বাড়ী": {"rate": 75194},
          "ভিটা": {"rate": 93402},
          "বাগান": {"rate": 21429},
          "পুকুর": {"rate": 54977},
          "ডোবা": {"rate": 12666}
        },
        "jl": "67"
      },
      "ভিয়ারকুল": {
        "rates": {
          "নাল": {"rate": 159060},
          "বাড়ী": {"rate": 3776},
          "ভিটা": {"rate": 10000},
          "বাগান": {"rate": 2100},
          "পুকুর": {"rate": 28949},
          "ডোবা": {"rate": 5643}
        },
        "jl": "56"
      },
      "ভেতকোটা": {
        "rates": {
          "নাল": {"rate": 45619},
          "বাড়ী": {"rate": 92237},
          "ভিটা": {"rate": 24785},
          "বাগান": {"rate": 37037},
          "পুকুর": {"rate": 37320},
          "ডোবা": {"rate": 11567}
        },
        "jl": "66"
      },
      "থানা মহিরা": {
        "rates": {
          "নাল": {"rate": 203529},
          "বাড়ী": {"rate": 227721},
          "ভিটা": {"rate": 224978},
          "বাগান": {"rate": 12400},
          "পুকুর": {"rate": 209956},
          "ডোবা": {"rate": 36144}
        },
        "jl": "31"
      },
      "দঃ জঙ্গলখীমাই": {
        "rates": {
          "নাল": {"rate": 1750},
          "বাড়ী": {"rate": 1750},
          "ভিটা": {"rate": 1750},
          "বাগান": {"rate": 1750},
          "পুকুর": {"rate": 1750},
          "ডোবা": {"rate": 1750}
        },
        "jl": "154"
      },
      "দক্ষিণ ভূর্ষি": {
        "rates": {
          "নাল": {"rate": 145339},
          "বাড়ী": {"rate": 94301},
          "ভিটা": {"rate": 29761},
          "বাগান": {"rate": 116820},
          "পুকুর": {"rate": 67466},
          "ডোবা": {"rate": 20690}
        },
        "jl": "79"
      },
      "দক্ষিণ সমুরা": {
        "rates": {
          "নাল": {"rate": 94941},
          "বাড়ী": {"rate": 67536},
          "ভিটা": {"rate": 8000},
          "বাগান": {"rate": 5475},
          "পুকুর": {"rate": 110527},
          "ডোবা": {"rate": 2596}
        },
        "jl": "65"
      },
      "ধারক": {
        "rates": {
          "নাল": {"rate": 44854},
          "বাড়ী": {"rate": 30831},
          "ভিটা": {"rate": 33500},
          "বাগান": {"rate": 4494},
          "পুকুর": {"rate": 32210},
          "ডোবা": {"rate": 6024}
        },
        "jl": "26"
      },
      "ফলঘাটা": {
        "rates": {
          "নাল": {"rate": 74943},
          "বাড়ী": {"rate": 123152},
          "ভিটা": {"rate": 99145},
          "বাগান": {"rate": 49246},
          "পুকুর": {"rate": 75874},
          "ডোবা": {"rate": 4672}
        },
        "jl": "71"
      },
      "খাউরভেজা": {
        "rates": {
          "নাল": {"rate": 25159},
          "বাড়ী": {"rate": 64984},
          "ভিটা": {"rate": 7000},
          "বাগান": {"rate": 18680},
          "পুকুর": {"rate": 117719},
          "ডোবা": {"rate": 11130}
        },
        "jl": "112"
      },
      "নলান্দা": {
        "rates": {
          "নাল": {"rate": 86026},
          "বাড়ী": {"rate": 51183},
          "ভিটা": {"rate": 275414},
          "বাগান": {"rate": 8000},
          "পুকুর": {"rate": 100000},
          "ডোবা": {"rate": 5747}
        },
        "jl": "02"
      },
      "নন্দেরখীল": {
        "rates": {
          "নাল": {"rate": 21203},
          "বাড়ী": {"rate": 71200},
          "ভিটা": {"rate": 6483},
          "বাগান": {"rate": 2000},
          "পুকুর": {"rate": 43340},
          "ডোবা": {"rate": 8571}
        },
        "jl": "64"
      },
      "নাইখাইন": {
        "rates": {
          "নাল": {"rate": 110504},
          "বাড়ী": {"rate": 137791},
          "ভিটা": {"rate": 195147},
          "বাগান": {"rate": 93878},
          "পুকুর": {"rate": 131853},
          "ডোবা": {"rate": 10331}
        },
        "jl": "55"
      },
      "পাইরোল": {
        "rates": {
          "নাল": {"rate": 191129},
          "বাড়ী": {"rate": 201024},
          "ভিটা": {"rate": 65204},
          "বাগান": {"rate": 2050},
          "পুকুর": {"rate": 97917},
          "ডোবা": {"rate": 19198}
        },
        "jl": "47"
      },
      "পাঁচগাছিয়া বড়দুয়ারা": {
        "rates": {
          "নাল": {"rate": 18471},
          "বাড়ী": {"rate": 1300},
          "ভিটা": {"rate": 1300},
          "বাগান": {"rate": 27363},
          "পুকুর": {"rate": 1300},
          "ডোবা": {"rate": 1300}
        },
        "jl": "86"
      },
      "পাঁচরিয়া": {
        "rates": {
          "নাল": {"rate": 114037},
          "বাড়ী": {"rate": 152999},
          "ভিটা": {"rate": 124007},
          "বাগান": {"rate": 80145},
          "পুকুর": {"rate": 98308},
          "ডোবা": {"rate": 38889}
        },
        "jl": "04"
      },
      "পাখিয়াম": {
        "rates": {
          "নাল": {"rate": 169486},
          "বাড়ী": {"rate": 115430},
          "ভিটা": {"rate": 64477},
          "বাগান": {"rate": 7250},
          "পুকুর": {"rate": 71033},
          "ডোবা": {"rate": 20366}
        },
        "jl": "95"
      },
      "পিঙ্গলা": {
        "rates": {
          "নাল": {"rate": 76235},
          "বাড়ী": {"rate": 163000},
          "ভিটা": {"rate": 55404},
          "বাগান": {"rate": 89334},
          "পুকুর": {"rate": 59083},
          "ডোবা": {"rate": 5374}
        },
        "jl": "25"
      },
      "পেপেরেরা": {
        "rates": {
          "নাল": {"rate": 31973},
          "বাড়ী": {"rate": 25831},
          "ভিটা": {"rate": 50739},
          "বাগান": {"rate": 194586},
          "পুকুর": {"rate": 47251},
          "ডোবা": {"rate": 6726}
        },
        "jl": "24"
      },
      "পেরলা": {
        "rates": {
          "নাল": {"rate": 137529},
          "বাড়ী": {"rate": 262053},
          "ভিটা": {"rate": 100000},
          "বাগান": {"rate": 5700},
          "পুকুর": {"rate": 68037},
          "ডোবা": {"rate": 10000}
        },
        "jl": "49"
      },
      "বগাহরা": {
        "rates": {
          "নাল": {"rate": 59753},
          "বাড়ী": {"rate": 50000},
          "ভিটা": {"rate": 5970},
          "বাগান": {"rate": 1650},
          "পুকুর": {"rate": 13426},
          "ডোবা": {"rate": 8757}
        },
        "jl": "101"
      },
      "বড়লিয়া": {
        "rates": {
          "নাল": {"rate": 61523},
          "বাড়ী": {"rate": 57899},
          "ভিটা": {"rate": 47449},
          "বাগান": {"rate": 10117},
          "পুকুর": {"rate": 98205},
          "ডোবা": {"rate": 12500}
        },
        "jl": "50"
      },
      "বরিয়া": {
        "rates": {
          "নাল": {"rate": 27866},
          "বাড়ী": {"rate": 45098},
          "ভিটা": {"rate": 32667},
          "বাগান": {"rate": 20000},
          "পুকুর": {"rate": 15751},
          "ডোবা": {"rate": 6334}
        },
        "jl": "111"
      },
      "বাঘখালী": {
        "rates": {
          "নাল": {"rate": 169604},
          "বাড়ী": {"rate": 42548},
          "ভিটা": {"rate": 33400},
          "বাগান": {"rate": 7692},
          "পুকুর": {"rate": 76389},
          "ডোবা": {"rate": 6000}
        },
        "jl": "99"
      },
      "বাগখাইন": {
        "rates": {
          "নাল": {"rate": 20766},
          "বাড়ী": {"rate": 50000},
          "ভিটা": {"rate": 5685},
          "বাগান": {"rate": 10078},
          "পুকুর": {"rate": 3815},
          "ডোবা": {"rate": 3333}
        },
        "jl": "20"
      },
      "বাগদন্ডী": {
        "rates": {
          "নাল": {"rate": 51706},
          "বাড়ী": {"rate": 55275},
          "ভিটা": {"rate": 50000},
          "বাগান": {"rate": 1707},
          "পুকুর": {"rate": 41360},
          "ডোবা": {"rate": 5291}
        },
        "jl": "63"
      },
      "বাহুরা": {
        "rates": {
          "নাল": {"rate": 32216},
          "বাড়ী": {"rate": 83728},
          "ভিটা": {"rate": 182000},
          "বাগান": {"rate": 33000},
          "পুকুর": {"rate": 52513},
          "ডোবা": {"rate": 45229}
        },
        "jl": "110"
      },
      "বানীগ্রাম": {
        "rates": {
          "নাল": {"rate": 54140},
          "বাড়ী": {"rate": 114085},
          "ভিটা": {"rate": 52267},
          "বাগান": {"rate": 41334},
          "পুকুর": {"rate": 68940},
          "ডোবা": {"rate": 8524}
        },
        "jl": "05"
      },
      "বানীপুর": {
        "rates": {
          "নাল": {"rate": 101298},
          "বাড়ী": {"rate": 50000},
          "ভিটা": {"rate": 160000},
          "বাগান": {"rate": 1700},
          "পুকুর": {"rate": 48834},
          "ডোবা": {"rate": 2000}
        },
        "jl": "68"
      },
      "বাঁশকাড়া": {
        "rates": {
          "নাল": {"rate": 58655},
          "বাড়ী": {"rate": 73835},
          "ভিটা": {"rate": 143915},
          "বাগান": {"rate": 2000},
          "পুকুর": {"rate": 105350},
          "ডোবা": {"rate": 10909}
        },
        "jl": "46"
      },
      "বিনানিহারা": {
        "rates": {
          "নাল": {"rate": 151624},
          "বাড়ী": {"rate": 163850},
          "ভিটা": {"rate": 178399},
          "বাগান": {"rate": 194805},
          "পুকুর": {"rate": 119142},
          "ডোবা": {"rate": 19512}
        },
        "jl": "37"
      },
      "বুধপুরা": {
        "rates": {
          "নাল": {"rate": 114073},
          "বাড়ী": {"rate": 175000},
          "ভিটা": {"rate": 2667},
          "বাগান": {"rate": 2605956},
          "পুকুর": {"rate": 99710},
          "ডোবা": {"rate": 17094}
        },
        "jl": "41"
      },
      "বেলখাইন": {
        "rates": {
          "নাল": {"rate": 40057},
          "বাড়ী": {"rate": 58074},
          "ভিটা": {"rate": 39070},
          "বাগান": {"rate": 12641},
          "পুকুর": {"rate": 78915},
          "ডোবা": {"rate": 6360}
        },
        "jl": "42"
      },
      "ভাটিখাইন": {
        "rates": {
          "নাল": {"rate": 115683},
          "বাড়ী": {"rate": 174786},
          "ভিটা": {"rate": 191607},
          "বাগান": {"rate": 133767},
          "পুকুর": {"rate": 100729},
          "ডোবা": {"rate": 8889}
        },
        "jl": "102"
      },
      "ভান্ডারগাঁও": {
        "rates": {
          "নাল": {"rate": 39271},
          "বাড়ী": {"rate": 58971},
          "ভিটা": {"rate": 27632},
          "বাগান": {"rate": 2100},
          "পুকুর": {"rate": 25673},
          "ডোবা": {"rate": 2511}
        },
        "jl": "21"
      },
      "মঠপাড়া": {
        "rates": {
          "নাল": {"rate": 123799},
          "বাড়ী": {"rate": 106041},
          "ভিটা": {"rate": 237829},
          "বাগান": {"rate": 62000},
          "পুকুর": {"rate": 129712},
          "ডোবা": {"rate": 6500}
        },
        "jl": "105"
      },
      "মনসা": {
        "rates": {
          "নাল": {"rate": 128657},
          "বাড়ী": {"rate": 273637},
          "ভিটা": {"rate": 84105},
          "বাগান": {"rate": 74286},
          "পুকুর": {"rate": 77334},
          "ডোবা": {"rate": 25800}
        },
        "jl": "36"
      },
      "মহিরা": {
        "rates": {
          "নাল": {"rate": 39440},
          "বাড়ী": {"rate": 73283},
          "ভিটা": {"rate": 6154},
          "বাগান": {"rate": 1730},
          "পুকুর": {"rate": 73773},
          "ডোবা": {"rate": 3333}
        },
        "jl": "27"
      },
      "মহিরা পেরপেরা": {
        "rates": {
          "নাল": {"rate": 23874},
          "বাড়ী": {"rate": 75132},
          "ভিটা": {"rate": 26951},
          "বাগান": {"rate": 74813},
          "পুকুর": {"rate": 63223},
          "ডোবা": {"rate": 1883}
        },
        "jl": "22"
      },
      "মহিরা হিখাইন": {
        "rates": {
          "নাল": {"rate": 46720},
          "বাড়ী": {"rate": 53150},
          "ভিটা": {"rate": 34842},
          "বাগান": {"rate": 2000},
          "পুকুর": {"rate": 32419},
          "ডোবা": {"rate": 5929}
        },
        "jl": "28"
      },
      "মালিয়ারা": {
        "rates": {
          "নাল": {"rate": 66590},
          "বাড়ী": {"rate": 122917},
          "ভিটা": {"rate": 121772},
          "বাগান": {"rate": 3000},
          "পুকুর": {"rate": 76886},
          "ডোবা": {"rate": 9010}
        },
        "jl": "19"
      },
      "মুজাফফরাবাদ": {
        "rates": {
          "নাল": {"rate": 142683},
          "বাড়ী": {"rate": 137725},
          "ভিটা": {"rate": 111359},
          "বাগান": {"rate": 27604},
          "পুকুর": {"rate": 87401},
          "ডোবা": {"rate": 14678}
        },
        "jl": "115"
      },
      "মুকুটনাইট": {
        "rates": {
          "নাল": {"rate": 63224},
          "বাড়ী": {"rate": 56667},
          "ভিটা": {"rate": 52546},
          "বাগান": {"rate": 2500},
          "পুকুর": {"rate": 49167},
          "ডোবা": {"rate": 80000}
        },
        "jl": "60"
      },
      "মেঘধর": {
        "rates": {
          "নাল": {"rate": 38828},
          "বাড়ী": {"rate": 145313},
          "ভিটা": {"rate": 69706},
          "বাগান": {"rate": 7519},
          "পুকুর": {"rate": 85859},
          "ডোবা": {"rate": 5171}
        },
        "jl": "52"
      },
      "মেহের আটি": {
        "rates": {
          "নাল": {"rate": 77130},
          "বাড়ী": {"rate": 155249},
          "ভিটা": {"rate": 333666},
          "বাগান": {"rate": 5000},
          "পুকুর": {"rate": 48696},
          "ডোবা": {"rate": 13636}
        },
        "jl": "44"
      },
      "মৈতলা": {
        "rates": {
          "নাল": {"rate": 31890},
          "বাড়ী": {"rate": 70202},
          "ভিটা": {"rate": 111112},
          "বাগান": {"rate": 100000},
          "পুকুর": {"rate": 104272},
          "ডোবা": {"rate": 6539}
        },
        "jl": "73"
      },
      "রন্তনপুর": {
        "rates": {
          "নাল": {"rate": 49788},
          "বাড়ী": {"rate": 28477},
          "ভিটা": {"rate": 74963},
          "বাগান": {"rate": 2370},
          "পুকুর": {"rate": 41250},
          "ডোবা": {"rate": 3815}
        },
        "jl": "74"
      },
      "রশিদাবাদ": {
        "rates": {
          "নাল": {"rate": 117214},
          "বাড়ী": {"rate": 145296},
          "ভিটা": {"rate": 45135},
          "বাগান": {"rate": 10000},
          "পুকুর": {"rate": 68587},
          "ডোবা": {"rate": 14474}
        },
        "jl": "117"
      },
      "লড়িহরা": {
        "rates": {
          "নাল": {"rate": 195586},
          "বাড়ী": {"rate": 55653},
          "ভিটা": {"rate": 200000},
          "বাগান": {"rate": 200000},
          "পুকুর": {"rate": 197596},
          "ডোবা": {"rate": 3572}
        },
        "jl": "58"
      },
      "লাউয়ারখীল": {
        "rates": {
          "নাল": {"rate": 33624},
          "বাড়ী": {"rate": 147619},
          "ভিটা": {"rate": 1847},
          "বাগান": {"rate": 2500},
          "পুকুর": {"rate": 59786},
          "ডোবা": {"rate": 3002}
        },
        "jl": "125"
      },
      "লাখেরা": {
        "rates": {
          "নাল": {"rate": 131319},
          "বাড়ী": {"rate": 186508},
          "ভিটা": {"rate": 131671},
          "বাগান": {"rate": 35778},
          "পুকুর": {"rate": 177276},
          "ডোবা": {"rate": 27388}
        },
        "jl": "06"
      },
      "খীমাই": {
        "rates": {
          "নাল": {"rate": 45070},
          "বাড়ী": {"rate": 96924},
          "ভিটা": {"rate": 133011},
          "বাগান": {"rate": 40034},
          "পুকুর": {"rate": 77382},
          "ডোবা": {"rate": 25450}
        },
        "jl": "91"
      },
      "৭৫ নং লট খীমাই": {
        "rates": {
          "নাল": {"rate": 16063},
          "বাড়ী": {"rate": 2250},
          "ভিটা": {"rate": 2250},
          "বাগান": {"rate": 8356},
          "পুকুর": {"rate": 13014},
          "ডোবা": {"rate": 3938}
        },
        "jl": "90"
      },
      "শোভনদন্ডী": {
        "rates": {
          "নাল": {"rate": 84083},
          "বাড়ী": {"rate": 128860},
          "ভিটা": {"rate": 200000},
          "বাগান": {"rate": 50000},
          "পুকুর": {"rate": 115614},
          "ডোবা": {"rate": 7500}
        },
        "jl": "121"
      },
      "শোভাং": {
        "rates": {
          "নাল": {"rate": 59615},
          "বাড়ী": {"rate": 164445},
          "ভিটা": {"rate": 24481},
          "বাগান": {"rate": 1350},
          "পুকুর": {"rate": 71500},
          "ডোবা": {"rate": 2190}
        },
        "jl": "123"
      },
      "সাঁইদাইর": {
        "rates": {
          "নাল": {"rate": 44040},
          "বাড়ী": {"rate": 55309},
          "ভিটা": {"rate": 350000},
          "বাগান": {"rate": 1700},
          "পুকুর": {"rate": 43863},
          "ডোবা": {"rate": 10000}
        },
        "jl": "40"
      },
      "সাতভেটিয়া": {
        "rates": {
          "নাল": {"rate": 120387},
          "বাড়ী": {"rate": 84348},
          "ভিটা": {"rate": 37000},
          "বাগান": {"rate": 2350},
          "পুকুর": {"rate": 860000},
          "ডোবা": {"rate": 3200}
        },
        "jl": "35"
      },
      "সাপমারা": {
        "rates": {
          "নাল": {"rate": 8535},
          "বাড়ী": {"rate": 1000},
          "ভিটা": {"rate": 1000},
          "বাগান": {"rate": 1000}
        },
        "jl": "85"
      },
      "হরিন খাইন": {
        "rates": {
          "নাল": {"rate": 110208},
          "বাড়ী": {"rate": 170944},
          "ভিটা": {"rate": 282095},
          "বাগান": {"rate": 194553},
          "পুকুর": {"rate": 186433},
          "ডোবা": {"rate": 17026}
        },
        "jl": "39"
      },
      "হাইদগাঁও": {
        "rates": {
          "নাল": {"rate": 83617},
          "বাড়ী": {"rate": 221598},
          "ভিটা": {"rate": 284276},
          "বাগান": {"rate": 117466},
          "পুকুর": {"rate": 120177},
          "ডোবা": {"rate": 55000}
        },
        "jl": "83"
      },
      "হাতিয়ার ঘোনা": {
        "rates": {
          "নাল": {"rate": 122160},
          "বাড়ী": {"rate": 837500},
          "ভিটা": {"rate": 104833},
          "বাগান": {"rate": 111111},
          "পুকুর": {"rate": 35295},
          "ডোবা": {"rate": 37416}
        },
        "jl": "120"
      },
      "হাবিলাসদ্বীপ": {
        "rates": {
          "নাল": {"rate": 93803},
          "বাড়ী": {"rate": 85308},
          "ভিটা": {"rate": 221894},
          "বাগান": {"rate": 77515},
          "পুকুর": {"rate": 60562},
          "ডোবা": {"rate": 38470}
        },
        "jl": "61"
      },
      "হালিমখাঁরচর": {
        "rates": {
          "নাল": {"rate": 104931},
          "বাড়ী": {"rate": 64269},
          "ভিটা": {"rate": 41250},
          "বাগান": {"rate": 164180},
          "পুকুর": {"rate": 62258},
          "ডোবা": {"rate": 31861}
        },
        "jl": "03"
      },
      "হিঞ্চিয়া": {
        "rates": {
          "নাল": {"rate": 66428},
          "বাড়ী": {"rate": 107742},
          "ভিটা": {"rate": 53261},
          "বাগান": {"rate": 85107},
          "পুকুর": {"rate": 85239},
          "ডোবা": {"rate": 130000}
        },
        "jl": "126"
      },
      "হুলাইন": {
        "rates": {
          "নাল": {"rate": 132125},
          "বাড়ী": {"rate": 154877},
          "ভিটা": {"rate": 177364},
          "বাগান": {"rate": 83267},
          "পুকুর": {"rate": 144855},
          "ডোবা": {"rate": 100000}
        },
        "jl": "57"
      },
      "আরাই": {
        "rates": {
          "নাল": {"rate": 291423},
          "বাড়ী": {"rate": 432995},
          "ভিটা": {"rate": 323077},
          "বাগান": {"rate": 71300},
          "পুকুর": {"rate": 313100},
          "ডোবা": {"rate": 140000}
        },
        "jl": "54",
        "thana": "পটিয়া পৌরএলাকা"
      },
      "ওধারা": {
        "rates": {
          "নাল": {"rate": 159154},
          "বাড়ী": {"rate": 275104},
          "ভিটা": {"rate": 115000},
          "বাগান": {"rate": 25000},
          "পুকুর": {"rate": 195713},
          "ডোবা": {"rate": 40000}
        },
        "jl": "128",
        "thana": "পটিয়া পৌরএলাকা"
      },
      "গোবিন্দারখীল": {
        "rates": {
          "নাল": {"rate": 343381},
          "বাড়ী": {"rate": 1019258},
          "ভিটা": {"rate": 1124005},
          "বাগান": {"rate": 108721},
          "পুকুর": {"rate": 178350},
          "ডোবা": {"rate": 102181}
        },
        "jl": "82",
        "thana": "পটিয়া পৌরএলাকা"
      },
      "পটিয়া": {
        "rates": {
          "নাল": {"rate": 420615},
          "বাড়ী": {"rate": 1207030},
          "ভিটা": {"rate": 1000992},
          "বাগান": {"rate": 100000},
          "পুকুর": {"rate": 313290},
          "ডোবা": {"rate": 80000}
        },
        "jl": "98",
        "thana": "পটিয়া পৌরএলাকা"
      },
      "পাইকপাড়া": {
        "rates": {
          "নাল": {"rate": 518582},
          "বাড়ী": {"rate": 428653},
          "ভিটা": {"rate": 550000},
          "বাগান": {"rate": 41819},
          "পুকুর": {"rate": 222684},
          "ডোবা": {"rate": 69200}
        },
        "jl": "97",
        "thana": "পটিয়া পৌরএলাকা"
      },
      "বাহুলী": {
        "rates": {
          "নাল": {"rate": 506029},
          "বাড়ী": {"rate": 424152},
          "ভিটা": {"rate": 1194030},
          "বাগান": {"rate": 275485},
          "পুকুর": {"rate": 325474},
          "ডোবা": {"rate": 32982}
        },
        "jl": "96",
        "thana": "পটিয়া পৌরএলাকা"
      },
      "সূচক্রদন্ডী": {
        "rates": {
          "নাল": {"rate": 620704},
          "বাড়ী": {"rate": 1126279},
          "ভিটা": {"rate": 1212897},
          "বাগান": {"rate": 1390722},
          "পুকুর": {"rate": 701568},
          "ডোবা": {"rate": 116955}
        },
        "jl": "81",
        "thana": "পটিয়া পৌরএলাকা"
      },
      "ইছানগর": {
        "rates": {
          "নাল": {"rate": 205682},
          "বাড়ী": {"rate": 321848},
          "ভিটা": {"rate": 252092},
          "বাগান": {"rate": 8000},
          "পুকুর": {"rate": 132692},
          "ডোবা": {"rate": 12157}
        },
        "jl": "20",
        "thana": "পশ্চিম পটিয়া"
      },
      "ধোয়াজনগর": {
        "rates": {
          "নাল": {"rate": 253242},
          "বাড়ী": {"rate": 217737},
          "ভিটা": {"rate": 390537},
          "বাগান": {"rate": 10000},
          "পুকুর": {"rate": 153375},
          "ডোবা": {"rate": 15038}
        },
        "jl": "11",
        "thana": "পশ্চিম পটিয়া"
      },
      "চরলক্ষ্যা (JL 13)": {
        "rates": {
          "নাল": {"rate": 282943},
          "বাড়ী": {"rate": 376642},
          "ভিটা": {"rate": 500419},
          "বাগান": {"rate": 55000},
          "পুকুর": {"rate": 206178},
          "ডোবা": {"rate": 126667}
        },
        "jl": "13",
        "thana": "পশ্চিম পটিয়া"
      },
      "চরলক্ষ্যা (JL 21)": {
        "rates": {
          "নাল": {"rate": 118668},
          "বাড়ী": {"rate": 185227},
          "ভিটা": {"rate": 219029},
          "বাগান": {"rate": 13500},
          "পুকুর": {"rate": 106250},
          "ডোবা": {"rate": 23281}
        },
        "jl": "21",
        "thana": "পশ্চিম পটিয়া"
      },
      "চরফরিদ": {
        "rates": {
          "নাল": {"rate": 290071},
          "বাড়ী": {"rate": 241000},
          "ভিটা": {"rate": 780000},
          "বাগান": {"rate": 42308},
          "পুকুর": {"rate": 465518},
          "ডোবা": {"rate": 166667}
        },
        "jl": "09",
        "thana": "পশ্চিম পটিয়া"
      },
      "চরপাথরঘাটা": {
        "rates": {
          "নাল": {"rate": 341997},
          "বাড়ী": {"rate": 595864},
          "ভিটা": {"rate": 671248},
          "বাগান": {"rate": 346269},
          "পুকুর": {"rate": 286954},
          "ডোবা": {"rate": 173500}
        },
        "jl": "19",
        "thana": "পশ্চিম পটিয়া"
      },
      "জুলধা": {
        "rates": {
          "নাল": {"rate": 126440},
          "বাড়ী": {"rate": 141069},
          "ভিটা": {"rate": 136570},
          "বাগান": {"rate": 7400},
          "পুকুর": {"rate": 145347},
          "ডোবা": {"rate": 127119}
        },
        "jl": "27",
        "thana": "পশ্চিম পটিয়া"
      },
      "দ্বীপকলামোড়ল": {
        "rates": {
          "নাল": {"rate": 186688},
          "বাড়ী": {"rate": 238966},
          "ভিটা": {"rate": 275833},
          "বাগান": {"rate": 11765},
          "পুকুর": {"rate": 248292},
          "ডোবা": {"rate": 254684}
        },
        "jl": "17",
        "thana": "পশ্চিম পটিয়া"
      },
      "দৌলতপুর": {
        "rates": {
          "নাল": {"rate": 248004},
          "বাড়ী": {"rate": 216486},
          "ভিটা": {"rate": 313545},
          "বাগান": {"rate": 258333},
          "পুকুর": {"rate": 208636},
          "ডোবা": {"rate": 62500}
        },
        "jl": "17",
        "thana": "পশ্চিম পটিয়া"
      },
      "ভাসারচর": {
        "rates": {
          "নাল": {"rate": 278706},
          "বাড়ী": {"rate": 148778},
          "ভিটা": {"rate": 125036},
          "বাগান": {"rate": 6000},
          "পুকুর": {"rate": 102721},
          "ডোবা": {"rate": 6000}
        },
        "jl": "22",
        "thana": "পশ্চিম পটিয়া"
      },
      "বড় উঠান": {
        "rates": {
          "নাল": {"rate": 183461},
          "বাড়ী": {"rate": 336452},
          "ভিটা": {"rate": 239695},
          "বাগান": {"rate": 205392},
          "পুকুর": {"rate": 170599},
          "ডোবা": {"rate": 208140}
        },
        "jl": "16",
        "thana": "পশ্চিম পটিয়া"
      },
      "শাহমীরপুর": {
        "rates": {
          "নাল": {"rate": 182947},
          "বাড়ী": {"rate": 173924},
          "ভিটা": {"rate": 191720},
          "বাগান": {"rate": 231974},
          "পুকুর": {"rate": 176004},
          "ডোবা": {"rate": 29956}
        },
        "jl": "28",
        "thana": "পশ্চিম পটিয়া"
      },
      "শিকলবাহা": {
        "rates": {
          "নাল": {"rate": 315524},
          "বাড়ী": {"rate": 355174},
          "ভিটা": {"rate": 301557},
          "বাগান": {"rate": 230245},
          "পুকুর": {"rate": 197795},
          "ডোবা": {"rate": 392308}
        },
        "jl": "08",
        "thana": "পশ্চিম পটিয়া"
      },
      "শিকলবাহা (১-৩৫০০ দাগ পর্যন্ত)": {
        "rates": {
          "নাল": {"rate": 221069},
          "বাড়ী": {"rate": 678985},
          "ভিটা": {"rate": 497678},
          "বাগান": {"rate": 253572},
          "পুকুর": {"rate": 485706},
          "ডোবা": {"rate": 275304}
        },
        "jl": "18",
        "thana": "পশ্চিম পটিয়া"
      },
      "শিকলবাহা (৩৫০১-শেষ পর্যন্ত)": {
        "rates": {
          "নাল": {"rate": 263361},
          "বাড়ী": {"rate": 74467},
          "ভিটা": {"rate": 93028},
          "বাগান": {"rate": 76306},
          "পুকুর": {"rate": 133000},
          "ডোবা": {"rate": 50000}
        },
        "jl": "18",
        "thana": "পশ্চিম পটিয়া"
      }
    }
  },
  raozan: {
    "name": "রাউজান",
    "period": "2025-2026",
    "mouzas": {
      "পূর্ব বিছাম": {
        "rates": {
          "নাল": {"rate": 4555},
          "বাড়ী": {"rate": 751},
          "ভিটা": {"rate": 751},
          "পুকুর": {"rate": 971}
        },
        "jl": "1"
      },
      "হলদিয়া": {
        "rates": {
          "নাল": {"rate": 28063},
          "বাড়ী": {"rate": 27778},
          "ভিটা": {"rate": 27778},
          "পুকুর": {"rate": 67431},
          "ডোবা": {"rate": 66668}
        },
        "jl": "2"
      },
      "বুধাবনপুর": {
        "rates": {
          "নাল": {"rate": 8085},
          "বাড়ী": {"rate": 17810},
          "ভিটা": {"rate": 17810},
          "পুকুর": {"rate": 8090}
        },
        "jl": "3"
      },
      "বুধাতুনপুর": {
        "rates": {
          "নাল": {"rate": 12751},
          "বাড়ী": {"rate": 19287},
          "ভিটা": {"rate": 19287},
          "বাগান": {"rate": 1090},
          "পুকুর": {"rate": 7697},
          "ডোবা": {"rate": 19500}
        },
        "jl": "4"
      },
      "বালারস": {
        "rates": {
          "নাল": {"rate": 8055},
          "বাড়ী": {"rate": 3145},
          "ভিটা": {"rate": 3145},
          "পুকুর": {"rate": 700}
        },
        "jl": "5"
      },
      "রামাবাবপুর": {
        "rates": {
          "নাল": {"rate": 20228},
          "বাড়ী": {"rate": 25000},
          "ভিটা": {"rate": 25000},
          "পুকুর": {"rate": 2550}
        },
        "jl": "6"
      },
      "নজরগাঁও": {
        "rates": {
          "নাল": {"rate": 8666},
          "বাড়ী": {"rate": 6586},
          "ভিটা": {"rate": 6586},
          "পুকুর": {"rate": 9500}
        },
        "jl": "7"
      },
      "বরখনা": {
        "rates": {
          "নাল": {"rate": 22367},
          "বাড়ী": {"rate": 6267},
          "ভিটা": {"rate": 6267},
          "পুকুর": {"rate": 2286}
        },
        "jl": "8"
      },
      "সিহরিছড়া": {
        "rates": {
          "নাল": {"rate": 18730},
          "বাড়ী": {"rate": 900},
          "ভিটা": {"rate": 900},
          "পুকুর": {"rate": 7537}
        },
        "jl": "9"
      },
      "এয়াছিননগর": {
        "rates": {
          "নাল": {"rate": 55108},
          "বাড়ী": {"rate": 57053},
          "ভিটা": {"rate": 57053},
          "বাগান": {"rate": 77520},
          "পুকুর": {"rate": 41558}
        },
        "jl": "10"
      },
      "উত্তর সর্তা": {
        "rates": {
          "নাল": {"rate": 57124},
          "বাড়ী": {"rate": 65537},
          "ভিটা": {"rate": 65537},
          "বাগান": {"rate": 150000},
          "পুকুর": {"rate": 44419}
        },
        "jl": "11"
      },
      "কড়েলগর": {
        "rates": {
          "নাল": {"rate": 57777},
          "বাড়ী": {"rate": 111444},
          "ভিটা": {"rate": 111444},
          "পুকুর": {"rate": 151715}
        },
        "jl": "12"
      },
      "নবিনপুর": {
        "rates": {
          "নাল": {"rate": 28591},
          "বাড়ী": {"rate": 28629},
          "ভিটা": {"rate": 28629},
          "বাগান": {"rate": 17450},
          "পুকুর": {"rate": 19866}
        },
        "jl": "13"
      },
      "সোহাজিপুর": {
        "rates": {
          "নাল": {"rate": 64887},
          "বাড়ী": {"rate": 42876},
          "ভিটা": {"rate": 42876},
          "পুকুর": {"rate": 48036}
        },
        "jl": "14"
      },
      "কৌশল্যা": {
        "rates": {
          "নাল": {"rate": 48977},
          "বাড়ী": {"rate": 140770},
          "ভিটা": {"rate": 140770},
          "বাগান": {"rate": 222024},
          "পুকুর": {"rate": 78242}
        },
        "jl": "15"
      },
      "লড়াইখাল": {
        "rates": {
          "নাল": {"rate": 65146},
          "বাড়ী": {"rate": 141129},
          "ভিটা": {"rate": 141129},
          "বাগান": {"rate": 82919},
          "পুকুর": {"rate": 73037},
          "ডোবা": {"rate": 19672}
        },
        "jl": "16"
      },
      "দক্ষিণ সর্তা": {
        "rates": {
          "নাল": {"rate": 80051},
          "বাড়ী": {"rate": 111808},
          "ভিটা": {"rate": 111808},
          "বাগান": {"rate": 121264},
          "পুকুর": {"rate": 40598}
        },
        "jl": "17"
      },
      "গহিরা (পৌরসভা)": {
        "rates": {
          "নাল": {"rate": 99300},
          "বাড়ী": {"rate": 92534},
          "ভিটা": {"rate": 92534},
          "বাগান": {"rate": 146878},
          "পুকুর": {"rate": 63643},
          "ডোবা": {"rate": 37600}
        },
        "jl": "18"
      },
      "ইছামপুর": {
        "rates": {
          "নাল": {"rate": 25247},
          "বাড়ী": {"rate": 36667},
          "ভিটা": {"rate": 36667},
          "বাগান": {"rate": 37000},
          "পুকুর": {"rate": 9081}
        },
        "jl": "19"
      },
      "বিনাজুরী": {
        "rates": {
          "নাল": {"rate": 25716},
          "বাড়ী": {"rate": 26003},
          "ভিটা": {"rate": 26003},
          "বাগান": {"rate": 65000},
          "পুকুর": {"rate": 23216}
        },
        "jl": "20"
      },
      "সুলতানপুর (পৌরসভা)": {
        "rates": {
          "নাল": {"rate": 215573},
          "বাড়ী": {"rate": 275298},
          "ভিটা": {"rate": 275298},
          "বাগান": {"rate": 87576},
          "পুকুর": {"rate": 246139}
        },
        "jl": "21"
      },
      "সাতঘরিয়া (পৌরসভা)": {
        "rates": {
          "নাল": {"rate": 205223},
          "বাড়ী": {"rate": 114881},
          "ভিটা": {"rate": 114881},
          "পুকুর": {"rate": 34476}
        },
        "jl": "22"
      },
      "শাহানগর (পৌরসভা)": {
        "rates": {
          "নাল": {"rate": 206888},
          "বাড়ী": {"rate": 132371},
          "ভিটা": {"rate": 132371},
          "বাগান": {"rate": 183306},
          "পুকুর": {"rate": 152194}
        },
        "jl": "23"
      },
      "মরিয়মাবাদ (পৌরসভা)": {
        "rates": {
          "নাল": {"rate": 80875},
          "বাড়ী": {"rate": 50010},
          "ভিটা": {"rate": 50010},
          "পুকুর": {"rate": 85034}
        },
        "jl": "24"
      },
      "ছলছাড়া (পৌরসভা)": {
        "rates": {
          "নাল": {"rate": 157228},
          "বাড়ী": {"rate": 67655},
          "ভিটা": {"rate": 67655},
          "বাগান": {"rate": 15235},
          "পুকুর": {"rate": 82897}
        },
        "jl": "25"
      },
      "কেউটিয়াহাট": {
        "rates": {
          "নাল": {"rate": 100586},
          "বাড়ী": {"rate": 45524},
          "ভিটা": {"rate": 45524},
          "পুকুর": {"rate": 117304}
        },
        "jl": "26"
      },
      "চিকনছড়া": {
        "rates": {
          "নাল": {"rate": 54808},
          "বাড়ী": {"rate": 71055},
          "ভিটা": {"rate": 71055},
          "বাগান": {"rate": 100000},
          "পুকুর": {"rate": 42276}
        },
        "jl": "27"
      },
      "ছাড়া": {
        "rates": {
          "নাল": {"rate": 59039},
          "বাড়ী": {"rate": 61946},
          "ভিটা": {"rate": 61946},
          "বাগান": {"rate": 151010},
          "পুকুর": {"rate": 38666}
        },
        "jl": "28"
      },
      "কুকুরা": {
        "rates": {
          "নাল": {"rate": 46915},
          "বাড়ী": {"rate": 9548},
          "ভিটা": {"rate": 9548},
          "বাগান": {"rate": 20000},
          "পুকুর": {"rate": 24000}
        },
        "jl": "29"
      },
      "হিংগলা": {
        "rates": {
          "নাল": {"rate": 42611},
          "বাড়ী": {"rate": 87762},
          "ভিটা": {"rate": 87762},
          "পুকুর": {"rate": 37773},
          "ডোবা": {"rate": 3759}
        },
        "jl": "30"
      },
      "মেছুয়া": {
        "rates": {
          "নাল": {"rate": 16797},
          "বাড়ী": {"rate": 1333},
          "ভিটা": {"rate": 1333},
          "পুকুর": {"rate": 877}
        },
        "jl": "31"
      },
      "জঙ্গল হাটহাজারী (পৌরসভা)": {
        "rates": {
          "নাল": {"rate": 15619},
          "বাড়ী": {"rate": 93334},
          "ভিটা": {"rate": 93334},
          "পুকুর": {"rate": 2806}
        },
        "jl": "32"
      },
      "জঙ্গল হাটহাজারী (পৌরসভার বাহিরে)": {
        "rates": {
          "নাল": {"rate": 11487},
          "বাড়ী": {"rate": 1665},
          "ভিটা": {"rate": 1665},
          "পুকুর": {"rate": 750}
        },
        "jl": "32"
      },
      "পূর্ব রাউজান (পৌরসভা)": {
        "rates": {
          "নাল": {"rate": 47867},
          "বাড়ী": {"rate": 3750},
          "ভিটা": {"rate": 3750},
          "পুকুর": {"rate": 17500}
        },
        "jl": "33"
      },
      "পূর্ব রাউজান (পৌরসভার বাহিরে)": {
        "rates": {
          "নাল": {"rate": 48781},
          "বাড়ী": {"rate": 72575},
          "ভিটা": {"rate": 72575},
          "বাগান": {"rate": 29667},
          "পুকুর": {"rate": 68013}
        },
        "jl": "33"
      },
      "কেউটিয়া": {
        "rates": {
          "নাল": {"rate": 70285},
          "বাড়ী": {"rate": 121379},
          "ভিটা": {"rate": 121379},
          "বাগান": {"rate": 90000},
          "পুকুর": {"rate": 66485}
        },
        "jl": "34"
      },
      "পশ্চিম রাউজান (পৌরসভা)": {
        "rates": {
          "নাল": {"rate": 103174},
          "বাড়ী": {"rate": 137398},
          "ভিটা": {"rate": 137398},
          "পুকুর": {"rate": 61844}
        },
        "jl": "35"
      },
      "পশ্চিম রাউজান (পৌরসভার বাহিরে)": {
        "rates": {
          "নাল": {"rate": 104529},
          "বাড়ী": {"rate": 167754},
          "ভিটা": {"rate": 167754},
          "পুকুর": {"rate": 90211},
          "ডোবা": {"rate": 33884}
        },
        "jl": "35"
      },
      "কমলপতি": {
        "rates": {
          "নাল": {"rate": 52637},
          "বাড়ী": {"rate": 15883},
          "ভিটা": {"rate": 15883},
          "পুকুর": {"rate": 25645}
        },
        "jl": "36"
      },
      "টেউপাড়া (পৌরসভা)": {
        "rates": {
          "নাল": {"rate": 358303},
          "বাড়ী": {"rate": 252465},
          "ভিটা": {"rate": 252465},
          "পুকুর": {"rate": 113377}
        },
        "jl": "37"
      },
      "কৈলাশপাড়া": {
        "rates": {
          "নাল": {"rate": 32009},
          "বাড়ী": {"rate": 91681},
          "ভিটা": {"rate": 91681},
          "পুকুর": {"rate": 66528}
        },
        "jl": "38"
      },
      "আফজাল (JL 39)": {
        "rates": {
          "নাল": {"rate": 20109},
          "বাড়ী": {"rate": 107879},
          "ভিটা": {"rate": 107879},
          "বাগান": {"rate": 153059},
          "পুকুর": {"rate": 11466}
        },
        "jl": "39"
      },
      "আফজাল (JL 51)": {
        "rates": {
          "নাল": {"rate": 55182},
          "বাড়ী": {"rate": 102797},
          "ভিটা": {"rate": 102797},
          "বাগান": {"rate": 102444},
          "পুকুর": {"rate": 31455}
        },
        "jl": "51"
      },
      "উত্তর ভরসা": {
        "rates": {
          "নাল": {"rate": 62880},
          "বাড়ী": {"rate": 95442},
          "ভিটা": {"rate": 95442},
          "বাগান": {"rate": 24000},
          "পুকুর": {"rate": 74853}
        },
        "jl": "40"
      },
      "পশ্চিম ভরসা": {
        "rates": {
          "নাল": {"rate": 66877},
          "বাড়ী": {"rate": 87715},
          "ভিটা": {"rate": 87715},
          "বাগান": {"rate": 36167},
          "পুকুর": {"rate": 68710}
        },
        "jl": "41"
      },
      "উত্তর কদলপুর": {
        "rates": {
          "নাল": {"rate": 116843},
          "বাড়ী": {"rate": 245761},
          "ভিটা": {"rate": 245761},
          "বাগান": {"rate": 220000},
          "পুকুর": {"rate": 168892}
        },
        "jl": "42"
      },
      "বইশাখ": {
        "rates": {
          "নাল": {"rate": 340745},
          "বাড়ী": {"rate": 512425},
          "ভিটা": {"rate": 512425},
          "বাগান": {"rate": 147140},
          "পুকুর": {"rate": 237480}
        },
        "jl": "40"
      },
      "হালদা": {
        "rates": {
          "নাল": {"rate": 204280},
          "বাড়ী": {"rate": 856766},
          "ভিটা": {"rate": 856766},
          "বাগান": {"rate": 400000},
          "পুকুর": {"rate": 325928}
        },
        "jl": "44"
      },
      "সার্বজনীন": {
        "rates": {
          "নাল": {"rate": 136855},
          "বাড়ী": {"rate": 50257},
          "ভিটা": {"rate": 50257},
          "পুকুর": {"rate": 112000}
        },
        "jl": "45"
      },
      "কচুখাইন": {
        "rates": {
          "নাল": {"rate": 133488},
          "বাড়ী": {"rate": 116221},
          "ভিটা": {"rate": 116221},
          "বাগান": {"rate": 46787},
          "পুকুর": {"rate": 110221}
        },
        "jl": "46"
      },
      "ছালিলপুর ঘোনা": {
        "rates": {
          "নাল": {"rate": 113791},
          "বাড়ী": {"rate": 106000},
          "ভিটা": {"rate": 106000},
          "পুকুর": {"rate": 112162}
        },
        "jl": "47"
      },
      "মোহাম্মদপুর": {
        "rates": {
          "নাল": {"rate": 155681},
          "বাড়ী": {"rate": 301234},
          "ভিটা": {"rate": 301234},
          "বাগান": {"rate": 89322},
          "পুকুর": {"rate": 154586}
        },
        "jl": "48"
      },
      "পশ্চিম পাড়া": {
        "rates": {
          "নাল": {"rate": 171485},
          "বাড়ী": {"rate": 81925},
          "ভিটা": {"rate": 81925},
          "বাগান": {"rate": 62500},
          "পুকুর": {"rate": 85828}
        },
        "jl": "49"
      },
      "পূর্ব ভরসা": {
        "rates": {
          "নাল": {"rate": 76542},
          "বাড়ী": {"rate": 100737},
          "ভিটা": {"rate": 100737},
          "বাগান": {"rate": 28075},
          "পুকুর": {"rate": 93002},
          "ডোবা": {"rate": 105556}
        },
        "jl": "50"
      },
      "পশ্চিম কমলপুর": {
        "rates": {
          "নাল": {"rate": 21119},
          "বাড়ী": {"rate": 77143},
          "ভিটা": {"rate": 77143},
          "বাগান": {"rate": 55814},
          "পুকুর": {"rate": 66402}
        },
        "jl": "55"
      },
      "কমলপুর": {
        "rates": {
          "নাল": {"rate": 93539},
          "বাড়ী": {"rate": 125725},
          "ভিটা": {"rate": 125725},
          "বাগান": {"rate": 204827},
          "পুকুর": {"rate": 112677}
        },
        "jl": "56"
      },
      "উনসত্তর পাড়া": {
        "rates": {
          "নাল": {"rate": 286565},
          "বাড়ী": {"rate": 472803},
          "ভিটা": {"rate": 472803},
          "বাগান": {"rate": 267190},
          "পুকুর": {"rate": 421265}
        },
        "jl": "57"
      },
      "নৈয়াখালী": {
        "rates": {
          "নাল": {"rate": 24463},
          "বাড়ী": {"rate": 50321},
          "ভিটা": {"rate": 50321},
          "বাগান": {"rate": 46666},
          "পুকুর": {"rate": 62586}
        },
        "jl": "58"
      },
      "গণি": {
        "rates": {
          "নাল": {"rate": 86575},
          "বাড়ী": {"rate": 215516},
          "ভিটা": {"rate": 215516},
          "বাগান": {"rate": 107082},
          "পুকুর": {"rate": 83276}
        },
        "jl": "59"
      },
      "পাঁচখাইন": {
        "rates": {
          "নাল": {"rate": 67852},
          "বাড়ী": {"rate": 61132},
          "ভিটা": {"rate": 61132},
          "বাগান": {"rate": 30121},
          "পুকুর": {"rate": 47302}
        },
        "jl": "60"
      },
      "দেওয়ানপুর": {
        "rates": {
          "নাল": {"rate": 55434},
          "বাড়ী": {"rate": 274635},
          "ভিটা": {"rate": 274635},
          "বাগান": {"rate": 155426},
          "পুকুর": {"rate": 67249},
          "ডোবা": {"rate": 74627}
        },
        "jl": "61"
      },
      "পাহাড়তলী": {
        "rates": {
          "নাল": {"rate": 130122},
          "বাড়ী": {"rate": 362656},
          "ভিটা": {"rate": 362656},
          "বাগান": {"rate": 325000},
          "পুকুর": {"rate": 259433},
          "ডোবা": {"rate": 300000}
        },
        "jl": "62"
      },
      "বাগোয়ান": {
        "rates": {
          "নাল": {"rate": 48982},
          "বাড়ী": {"rate": 20186},
          "ভিটা": {"rate": 20186},
          "বাগান": {"rate": 73334},
          "পুকুর": {"rate": 60973},
          "ডোবা": {"rate": 73215}
        },
        "jl": "63"
      }
    }
  }
};

function norm(s) { return String(s == null ? '' : s).trim(); }

// One mouza record resolves to a list of rate variants: a plain
// entry is a single variant; a qualified name (Chandgaon
// collisions) carries `variants`, one per thana.
function variantsOf(rec) {
  if (!rec) return [];
  if (Array.isArray(rec.variants)) return rec.variants;
  return [rec];
}

function hitFrom(officeId, o, mouza, variant, cls) {
  const r = variant.rates[norm(cls)];
  if (!r) return null;
  const hit = {
    office: officeId,
    officeName: o.name,
    mouza: norm(mouza),
    class: norm(cls),
    rate: r.rate,
    period: o.period,
    p: r.p === true,
  };
  if (variant.thana) hit.thana = variant.thana;
  if (variant.jl) hit.jl = variant.jl;
  // Sandwip pouro note: only meaningful for পুকুর lookups, and
  // it never replaces the gram rate (the gram value stays).
  if (norm(cls) === 'পুকুর' && variant.pouroPukur) {
    hit.pouroPukur = variant.pouroPukur;
    hit.pouroNote = 'পৌর এলাকার হার: ' + variant.pouroPukur + ' টাকা — গ্রাম-মান দেখানো হয়েছে';
  }
  return hit;
}

/**
 * lookupMouzaRate(office, mouza, cls, thana?)
 * Returns null when there is no lookup rate (unknown office,
 * unknown mouza, or a class with no exact-name rate — including
 * বাণিজ্যিক, which has no lookup rate anywhere).
 * Otherwise { office, officeName, mouza, class, rate, period, p,
 * thana?, jl?, pouroPukur?, pouroNote? }.
 * Rate is ALWAYS per shatangsho.
 * AMBIGUITY (qualified names only): when several variants carry
 * a rate for the class and no thana is given, returns
 * { ambiguous: true, options: [thana names] } instead of a
 * rate — the caller must ask for the thana. A variant that
 * lacks the class rate does NOT count toward ambiguity, so a
 * query matching exactly one variant returns that rate.
 * A thana given for an unqualified mouza matches nothing — the
 * mouza has no thana to match, so it is a miss (found:false),
 * never a silent fallback to the single variant.
 */
function lookupMouzaRate(office, mouza, cls, thana) {
  const o = OFFICES[norm(office)];
  if (!o) return null;
  const rec = o.mouzas[norm(mouza)];
  if (!rec) return null;
  const variants = variantsOf(rec);
  const t = norm(thana);
  if (t) {
    const v = variants.find((x) => norm(x.thana) === t);
    return v ? hitFrom(norm(office), o, mouza, v, cls) : null;
  }
  const hits = variants.map((v) => hitFrom(norm(office), o, mouza, v, cls)).filter(Boolean);
  if (hits.length === 0) return null;
  if (hits.length === 1) return hits[0];
  return {
    ambiguous: true,
    office: norm(office),
    officeName: o.name,
    mouza: norm(mouza),
    class: norm(cls),
    period: o.period,
    options: hits.map((h) => h.thana),
  };
}

/** Classes shown on a mouza rate card, in order. বাণিজ্যিক has
 * no lookup rate anywhere, so its card entry is always null —
 * picking it leads to the manual-rate path with a plain WHY. */
const CARD_CLASSES = ['নাল', 'বাড়ী', 'ভিটা', 'বাগান', 'পুকুর', 'ডোবা', 'বাণিজ্যিক'];

/**
 * lookupMouzaCard(office, mouza, thana?)
 * Whole-mouza rate card for the guided wizard: ALL classes'
 * rates in one call, so the customer can SEE what exists
 * before picking a class.
 * Returns null when the office has no lookup data at all
 * (OFFICE_NOT_COVERED at the route).
 * Returns { notInTable: true, ... } when the office is covered
 * but the mouza is not in its table (MOUZA_NOT_IN_TABLE).
 * Returns { ambiguous: true, options: [thanas] } when several
 * thana variants exist and no thana was given — the card cannot
 * pick one variant's rates, so the caller must ask "কোন থানা?".
 * (Unlike the single-class lookup, there is no single-variant
 * shortcut here: a card shows every class, so any multi-variant
 * mouza is ambiguous until a thana is picked.)
 * Otherwise { office, officeName, mouza, thana?, jl?, period,
 * rates: { class: { rate: number|null, p: bool,
 * pouroPukur?, pouroNote? } } } — a null rate means the table
 * has no rate for that class (never 0).
 */
function lookupMouzaCard(office, mouza, thana) {
  const o = OFFICES[norm(office)];
  if (!o) return null;
  const rec = o.mouzas[norm(mouza)];
  if (!rec) {
    return { notInTable: true, office: norm(office), officeName: o.name, mouza: norm(mouza) };
  }
  const variants = variantsOf(rec);
  const t = norm(thana);
  if (t) {
    const v = variants.find((x) => norm(x.thana) === t);
    if (!v) {
      return { badThana: true, office: norm(office), officeName: o.name, mouza: norm(mouza), thana: t };
    }
    return cardFrom(norm(office), o, mouza, v);
  }
  if (variants.length > 1) {
    return {
      ambiguous: true,
      office: norm(office),
      officeName: o.name,
      mouza: norm(mouza),
      period: o.period,
      options: variants.map((v) => v.thana),
    };
  }
  return cardFrom(norm(office), o, mouza, variants[0]);
}

function cardFrom(officeId, o, mouza, variant) {
  const rates = {};
  for (const cls of CARD_CLASSES) {
    const r = variant.rates[cls];
    if (!r) { rates[cls] = { rate: null, p: false }; continue; }
    const entry = { rate: r.rate, p: r.p === true };
    if (cls === 'পুকুর' && variant.pouroPukur) {
      entry.pouroPukur = variant.pouroPukur;
      entry.pouroNote = 'পৌর এলাকার হার: ' + variant.pouroPukur + ' টাকা — গ্রাম-মান দেখানো হয়েছে';
    }
    rates[cls] = entry;
  }
  const card = {
    office: officeId,
    officeName: o.name,
    mouza: norm(mouza),
    period: o.period,
    rates,
  };
  if (variant.thana) card.thana = variant.thana;
  if (variant.jl) card.jl = variant.jl;
  return card;
}

/** Offices available for lookup: [{ id, name, period, mouzas: [names] }]. */
function listLookupOffices() {
  return Object.entries(OFFICES).map(([id, o]) => ({
    id,
    name: o.name,
    period: o.period,
    mouzas: Object.keys(o.mouzas),
  }));
}

/** Lookup classes for one office+mouza: [class names with a rate]. */
/** For qualified names this is the union across variants. */
function listLookupClasses(office, mouza) {
  const o = OFFICES[norm(office)];
  if (!o) return [];
  const rec = o.mouzas[norm(mouza)];
  if (!rec) return [];
  const out = [];
  for (const v of variantsOf(rec)) {
    for (const c of Object.keys(v.rates)) if (!out.includes(c)) out.push(c);
  }
  return out;
}

module.exports = { OFFICES, lookupMouzaRate, lookupMouzaCard, listLookupOffices, listLookupClasses };
