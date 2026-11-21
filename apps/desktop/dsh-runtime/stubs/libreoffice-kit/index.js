// dsh の Office スキル (@deepseek-ai/dsh-skill-office) が依存する LibreOffice キットの差し替え。
// 内蔵AIは sdk-minimal プロファイルで動き、Office スキルを読み込まない。万一読み込まれたら、
// 黙って壊れた変換をするのではなく、ここで理由つきで止める。
throw new Error("LibreOffice is not part of the SIGMA Studio dsh runtime.");
