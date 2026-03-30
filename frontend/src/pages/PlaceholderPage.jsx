import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card.jsx'

export function PlaceholderPage({ title, phase }) {
  return (
    <div className="mx-auto max-w-lg space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>
            Coming soon — {phase}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            This area is reserved for a future phase. Use the sidebar to access models and the modelfile
            editor.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
